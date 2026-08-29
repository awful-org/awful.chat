import { describe, expect, it } from "vitest";
import { LibP2PVoice, isVoiceSignal } from "./voice";

function makeVoice() {
  const transport = {
    selfId: () => "zzz",
    peers: () => [],
    isRelay: () => false,
    send: async () => {},
    on: () => {},
    off: () => {},
  };
  const voice = new LibP2PVoice(transport as never, null);
  const internals = voice as never as Record<string, unknown>;
  return { voice, internals };
}

describe("isVoiceSignal", () => {
  it("accepts a well-formed offer/answer", () => {
    expect(isVoiceSignal({ type: "offer", sdp: "v=0..." })).toBe(true);
    expect(isVoiceSignal({ type: "answer", sdp: "v=0..." })).toBe(true);
  });

  it("accepts a well-formed ice candidate", () => {
    expect(
      isVoiceSignal({ type: "ice", candidate: { candidate: "candidate:1 ..." } })
    ).toBe(true);
  });

  it("rejects an unknown type", () => {
    expect(isVoiceSignal({ type: "eval", sdp: "x" })).toBe(false);
  });

  it("rejects a non-string sdp", () => {
    expect(isVoiceSignal({ type: "offer", sdp: 123 })).toBe(false);
  });

  it("rejects an ice signal whose candidate is missing the candidate string", () => {
    expect(isVoiceSignal({ type: "ice", candidate: {} })).toBe(false);
    expect(isVoiceSignal({ type: "ice", candidate: "not-an-object" })).toBe(
      false
    );
  });

  it("rejects non-objects", () => {
    expect(isVoiceSignal(null)).toBe(false);
    expect(isVoiceSignal("offer")).toBe(false);
    expect(isVoiceSignal(42)).toBe(false);
  });
});

describe("admitsInboundStream (default-deny inbound guard)", () => {
  it("denies before the roster has been fed at least once", () => {
    const { internals } = makeVoice();
    expect(internals.rosterSeen as boolean).toBe(false);
    expect(
      (internals.admitsInboundStream as (id: string) => boolean)("aaa")
    ).toBe(false);
  });

  it("denies a peer not on the roster once fed", () => {
    const { voice, internals } = makeVoice();
    voice.setCallPeers(["bbb"]);
    expect(
      (internals.admitsInboundStream as (id: string) => boolean)("aaa")
    ).toBe(false);
  });

  it("admits a peer once the roster has been fed and includes them", () => {
    const { voice, internals } = makeVoice();
    voice.setCallPeers(["aaa"]);
    expect(
      (internals.admitsInboundStream as (id: string) => boolean)("aaa")
    ).toBe(true);
  });

  it("goes back to default-deny after leave()", () => {
    const { voice, internals } = makeVoice();
    voice.setCallPeers(["aaa"]);
    voice.leave();
    expect(internals.rosterSeen as boolean).toBe(false);
    expect(
      (internals.admitsInboundStream as (id: string) => boolean)("aaa")
    ).toBe(false);
  });
});

describe("pendingCandidates cap", () => {
  it("stops buffering at MAX_PENDING_CANDIDATES, dropping the newest", async () => {
    const { internals } = makeVoice();
    const remote = {
      pc: { remoteDescription: null },
      pendingCandidates: [] as unknown[],
    };
    (internals.remotePeers as Map<string, unknown>).set("aaa", remote);

    // Called through `internals`, not extracted into a local, so `this`
    // still resolves to the voice instance - handleSignal is a normal
    // (unbound) method.
    for (let i = 0; i < 300; i++) {
      await (
        internals.handleSignal as (
          peerId: string,
          signal: unknown
        ) => Promise<void>
      ).call(internals, "aaa", {
        type: "ice",
        candidate: { candidate: `candidate:${i}` },
      });
    }

    expect(remote.pendingCandidates.length).toBe(256);
    // The first 256 survive; the rest were dropped rather than evicting them.
    expect(
      (remote.pendingCandidates[0] as { candidate: string }).candidate
    ).toBe("candidate:0");
  });
});
