import { base64urlnopad } from "@scure/base";
import { openRoomEnvelope, sealRoomEnvelope, MAX_ROOM_PLAINTEXT } from "./envelope";
import { MembershipSession, type MembershipFrame } from "./session";
import type { RoomKeys } from "./keys";
import { ReplayWindow } from "./replay";

export const MAX_ROOM_MESSAGE = 4 * 1024 * 1024;
const CHUNK_BYTES = 256 * 1024;

/** A dedicated, ordered, Noise-authenticated bidirectional stream. These
 * payloads MUST NOT be forwarded into pubsub: identity is authenticated by
 * the stream, not by a standalone message signature.
 */
export class SecureRoomChannel {
  readonly ready: Promise<void>;
  private resolveReady!: () => void;
  private rejectReady!: (error: Error) => void;
  private readonly session: MembershipSession;
  private readonly replay = new ReplayWindow();
  private readonly sessionId: string;
  private sequence = 0;
  private closed = false;
  private established = false;
  private receivedSession: string | null = null;
  private processing = Promise.resolve();
  private outgoing = Promise.resolve();
  private pendingBytes = 0;
  private pendingFrames = 0;
  private outgoingBytes = 0;
  private outgoingFrames = 0;
  private assembly: { id: number; total: number; offset: number; bytes: Uint8Array } | null = null;
  private assemblyTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly timer: ReturnType<typeof setTimeout>;

  constructor(
    private readonly keys: RoomKeys,
    private readonly local: string,
    private readonly remote: string,
    role: "initiator" | "responder",
    private readonly write: (frame: unknown) => Promise<void>,
    private readonly deliver: (data: Uint8Array) => void,
    private readonly abort: () => void,
  ) {
    this.session = new MembershipSession(keys, local, remote, role);
    this.sessionId = base64urlnopad.encode(crypto.getRandomValues(new Uint8Array(32)));
    this.ready = new Promise((resolve, reject) => { this.resolveReady = resolve; this.rejectReady = reject; });
    // An inbound session has no caller awaiting ready yet.
    void this.ready.catch(() => {});
    this.timer = setTimeout(() => this.close(), 10_000);
    if (role === "initiator") void this.write(this.session.start()).catch(() => this.close());
  }

  get verified(): boolean { return !this.closed && this.established; }

  receive(frame: unknown, bytes: number): void {
    if (this.closed) return;
    if (!Number.isSafeInteger(bytes) || bytes < 0 || bytes > 2 * MAX_ROOM_PLAINTEXT ||
        this.pendingFrames >= 32 || this.pendingBytes + bytes > 4 * MAX_ROOM_PLAINTEXT) {
      this.close(); return;
    }
    this.pendingFrames++;
    this.pendingBytes += bytes;
    this.processing = this.processing.then(async () => {
      if (this.closed) return;
      if (!this.established) {
        if (bytes > 2048) throw new Error("Oversized membership frame");
        const reply = this.session.receive(frame);
        if (reply) await this.write(reply);
        if (this.closed) return;
        if (this.session.verified) {
          this.established = true;
          clearTimeout(this.timer);
          this.resolveReady();
        }
        return;
      }
      const raw = await openRoomEnvelope(this.keys, frame);
      if (this.closed) return;
      const outer = frame as { sender: string; kind: string };
      if (outer.sender !== this.remote || outer.kind !== "direct") throw new Error("Wrong room sender");
      const body = JSON.parse(new TextDecoder().decode(raw));
      if (body.sender !== this.remote || body.recipient !== this.local || body.room !== this.keys.discoveryId ||
          typeof body.session !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(body.session) ||
          typeof body.data !== "string") throw new Error("Invalid room payload");
      // Bind session to this fresh membership transcript, not an attacker-chosen
      // session ID from a previously recorded encrypted envelope.
      if (body.membership !== this.binding) throw new Error("Stale room session");
      if (this.receivedSession !== null && this.receivedSession !== body.session) throw new Error("Room session changed");
      if (!this.replay.accept(body.sequence)) throw new Error("Room replay");
      this.receivedSession = body.session;
      const data = base64urlnopad.decode(body.data);
      if (base64urlnopad.encode(data) !== body.data) throw new Error("Invalid room encoding");
      if (!Number.isSafeInteger(body.message) || body.message < 0 ||
          !Number.isSafeInteger(body.offset) || body.offset < 0 ||
          !Number.isSafeInteger(body.total) || body.total < 0 || body.total > MAX_ROOM_MESSAGE ||
          data.length > CHUNK_BYTES || body.offset + data.length > body.total ||
          (data.length === 0 && body.total !== 0)) throw new Error("Invalid room fragment");
      if (!this.assembly) {
        if (body.offset !== 0 || body.message !== body.sequence) throw new Error("Missing room fragment");
        this.assembly = { id: body.message, total: body.total, offset: 0, bytes: new Uint8Array(body.total) };
        this.assemblyTimer = setTimeout(() => this.close(), 30_000);
      }
      const assembly = this.assembly;
      if (assembly.id !== body.message || assembly.total !== body.total || assembly.offset !== body.offset) {
        throw new Error("Out-of-order room fragment");
      }
      assembly.bytes.set(data, assembly.offset);
      assembly.offset += data.length;
      if (assembly.offset === assembly.total) {
        clearTimeout(this.assemblyTimer!);
        this.assemblyTimer = null;
        this.assembly = null;
        this.deliver(assembly.bytes);
      }
    }).catch(() => this.close()).finally(() => {
      this.pendingFrames--; this.pendingBytes -= bytes;
    });
  }

  private get binding(): string { return this.session.binding; }

  async send(data: Uint8Array): Promise<boolean> {
    const fragments = Math.max(1, Math.ceil(data.length / CHUNK_BYTES));
    if (!this.verified || data.length > MAX_ROOM_MESSAGE || this.sequence > Number.MAX_SAFE_INTEGER - fragments ||
        this.outgoingFrames >= 32 || this.outgoingBytes + data.length > 4 * MAX_ROOM_PLAINTEXT) return false;
    this.outgoingFrames++;
    this.outgoingBytes += data.length;
    const message = this.sequence;
    this.sequence += fragments;
    const copy = new Uint8Array(data);
    const job = this.outgoing.then(async () => {
      if (!this.verified) throw new Error("Room channel closed");
      for (let index = 0; index < fragments; index++) {
        const offset = index * CHUNK_BYTES;
        const frame = await sealRoomEnvelope(this.keys, this.local, "direct", new TextEncoder().encode(JSON.stringify({
          room: this.keys.discoveryId, sender: this.local, recipient: this.remote,
          session: this.sessionId, membership: this.binding, sequence: message + index,
          message, offset, total: copy.length,
          data: base64urlnopad.encode(copy.subarray(offset, offset + CHUNK_BYTES)),
        })));
        if (!this.verified) throw new Error("Room channel closed");
        await this.write(frame);
      }
    });
    this.outgoing = job.catch(() => this.close());
    try { await job; return true; } catch { return false; }
    finally { this.outgoingFrames--; this.outgoingBytes -= copy.length; }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.timer);
    if (this.assemblyTimer) clearTimeout(this.assemblyTimer);
    this.assemblyTimer = null;
    this.assembly = null;
    this.session.close();
    this.rejectReady(new Error("Room verification or channel failed"));
    this.abort();
  }
}

export function isMembershipHello(input: unknown): input is Extract<MembershipFrame, { type: "hello" }> {
  if (!input || typeof input !== "object") return false;
  const f = input as MembershipFrame;
  return f.version === 2 && f.type === "hello" && typeof f.room === "string" &&
    /^rd2_[A-Za-z0-9_-]{43}$/.test(f.room) && typeof f.challenge === "string" && /^[A-Za-z0-9_-]{43}$/.test(f.challenge);
}
