import type { RoomKeys } from "./keys";
import {
  createMembershipProof, newMembershipChallenge, verifyMembershipProof,
  type MembershipTranscript,
} from "./membership";

export type MembershipFrame =
  | { version: 2; type: "hello"; room: string; challenge: string }
  | { version: 2; type: "challenge"; room: string; challenge: string; proof: string }
  | { version: 2; type: "finish"; room: string; proof: string };

/** One instance per room and authenticated connection, never per peer alone.
 * Its owner must close it on connection replacement/disconnect and impose a
 * global pending-session cap. No application data may pass until verified.
 * Authentication failures are terminal: retry requires a new connection session.
 */
export class MembershipSession {
  private state: "new" | "waiting" | "verified" | "closed" = "new";
  private transcript: MembershipTranscript;
  private readonly deadline: number;

  constructor(
    private readonly keys: RoomKeys,
    localPeer: string,
    remotePeer: string,
    private readonly role: "initiator" | "responder",
    private readonly now: () => number = () => performance.now(),
  ) {
    if (!localPeer || !remotePeer || localPeer === remotePeer || localPeer.length > 256 || remotePeer.length > 256) {
      throw new Error("Invalid authenticated peers");
    }
    this.deadline = now() + 10_000;
    this.transcript = {
      room: keys.discoveryId,
      initiator: role === "initiator" ? localPeer : remotePeer,
      responder: role === "responder" ? localPeer : remotePeer,
      initiatorChallenge: role === "initiator" ? newMembershipChallenge() : "",
      responderChallenge: role === "responder" ? newMembershipChallenge() : "",
    };
  }

  get verified(): boolean { return this.state === "verified"; }

  /** Fresh on every handshake; authenticated inside subsequent data envelopes. */
  get binding(): string {
    if (!this.verified) throw new Error("Unverified room session");
    return `${this.transcript.initiatorChallenge}.${this.transcript.responderChallenge}`;
  }

  close(): void {
    this.state = "closed";
    this.transcript.initiatorChallenge = "";
    this.transcript.responderChallenge = "";
  }

  start(): MembershipFrame {
    if (this.state !== "new" || this.role !== "initiator" || this.now() >= this.deadline) {
      this.close();
      throw new Error("Membership session cannot start");
    }
    this.state = "waiting";
    return { version: 2, type: "hello", room: this.keys.discoveryId, challenge: this.transcript.initiatorChallenge };
  }

  receive(input: unknown): MembershipFrame | null {
    try {
      if (this.state === "closed" || this.state === "verified" || this.now() >= this.deadline ||
          !input || typeof input !== "object") throw new Error("Invalid membership state");
      const frame = input as MembershipFrame;
      if (frame.version !== 2 || frame.room !== this.keys.discoveryId) throw new Error("Wrong membership context");
      if (this.role === "responder" && this.state === "new" && frame.type === "hello") {
        this.transcript.initiatorChallenge = frame.challenge;
        // createMembershipProof validates canonical challenge encoding before replying.
        const proof = createMembershipProof(this.keys, this.transcript, "responder");
        this.state = "waiting";
        return { version: 2, type: "challenge", room: this.keys.discoveryId,
          challenge: this.transcript.responderChallenge, proof };
      }
      if (this.role === "initiator" && this.state === "waiting" && frame.type === "challenge") {
        this.transcript.responderChallenge = frame.challenge;
        if (!verifyMembershipProof(this.keys, this.transcript, "responder", frame.proof)) throw new Error("Membership rejected");
        const proof = createMembershipProof(this.keys, this.transcript, "initiator");
        this.state = "verified";
        // Owner MUST write finish before releasing queued application messages.
        return { version: 2, type: "finish", room: this.keys.discoveryId, proof };
      }
      if (this.role === "responder" && this.state === "waiting" && frame.type === "finish") {
        if (!verifyMembershipProof(this.keys, this.transcript, "initiator", frame.proof)) throw new Error("Membership rejected");
        this.state = "verified";
        return null;
      }
      throw new Error("Unexpected membership frame");
    } catch {
      this.close();
      throw new Error("Room membership verification failed");
    }
  }
}
