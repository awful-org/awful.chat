import { describe, it, expect, vi } from "vitest";
import { probeTurnAllocation, turnOnly } from "./net-probe";

const TURN: RTCIceServer = {
  urls: ["turn:turn.example:3478?transport=udp", "stun:turn.example:3478"],
  username: "u",
  credential: "c",
};
const STUN: RTCIceServer = { urls: "stun:stun.example:19302" };

/** A peer connection that gathers exactly what the case asks it to. */
function fakePc(script: {
  candidates?: Array<{ candidate: string; type?: string }>;
  gathered?: boolean;
}) {
  const pc = {
    onicecandidate: null as null | ((e: unknown) => void),
    onicegatheringstatechange: null as null | (() => void),
    iceGatheringState: "gathering",
    closed: false,
    createDataChannel: vi.fn(),
    createOffer: vi.fn(async () => ({ type: "offer", sdp: "v=0" })),
    setLocalDescription: vi.fn(async () => {
      // Gathering starts after the local description, as in a real browser.
      queueMicrotask(() => {
        for (const c of script.candidates ?? []) {
          pc.onicecandidate?.({ candidate: c });
        }
        if (script.gathered) {
          pc.iceGatheringState = "complete";
          pc.onicegatheringstatechange?.();
        }
      });
    }),
    close: vi.fn(() => {
      pc.closed = true;
    }),
  };
  return pc;
}

describe("turnOnly", () => {
  it("keeps only credentialled TURN urls", () => {
    expect(turnOnly([TURN, STUN])).toEqual([
      { urls: ["turn:turn.example:3478?transport=udp"], username: "u", credential: "c" },
    ]);
  });

  it("drops a TURN entry with no credential - it can never allocate", () => {
    expect(turnOnly([{ urls: "turn:turn.example:3478" }])).toEqual([]);
  });
});

describe("probeTurnAllocation", () => {
  it("passes when a relay candidate is gathered", async () => {
    const pc = fakePc({
      candidates: [{ candidate: "candidate:1 1 udp 1 1.2.3.4 1 typ relay", type: "relay" }],
    });
    const res = await probeTurnAllocation([TURN], { createPc: () => pc as never });
    expect(res).toMatchObject({ ok: true, outcome: "candidate", relayCandidates: 1 });
    // The probe must not add to the very budget it helps diagnose.
    expect(pc.close).toHaveBeenCalled();
  });

  it("fails when gathering completes with nothing", async () => {
    // The verdict that matters: credentials were fine, the network is not.
    const pc = fakePc({ gathered: true });
    const res = await probeTurnAllocation([TURN], { createPc: () => pc as never });
    expect(res).toMatchObject({ ok: false, outcome: "gathered-none", relayCandidates: 0 });
    expect(pc.close).toHaveBeenCalled();
  });

  it("fails on the clock when nothing is ever gathered", async () => {
    const pc = fakePc({});
    const res = await probeTurnAllocation([TURN], {
      createPc: () => pc as never,
      timeoutMs: 10,
    });
    expect(res).toMatchObject({ ok: false, outcome: "timeout" });
  });

  it("refuses to call a host candidate a passing TURN probe", async () => {
    // A browser that ignores iceTransportPolicy would otherwise turn a local
    // candidate into proof that a TURN server answered.
    const pc = fakePc({
      candidates: [{ candidate: "candidate:1 1 udp 1 192.168.0.2 1 typ host", type: "host" }],
      gathered: true,
    });
    const res = await probeTurnAllocation([TURN], { createPc: () => pc as never });
    expect(res).toMatchObject({ ok: false, outcome: "gathered-none" });
  });

  it("says nothing when there is no TURN to ask", async () => {
    // Not a failure: the credential path already reports a missing
    // credential, and reporting it twice double-counts it in every rule.
    expect(await probeTurnAllocation([STUN], { createPc: () => fakePc({}) as never })).toBeNull();
  });

  it("reports a throw instead of propagating it", async () => {
    const res = await probeTurnAllocation([TURN], {
      createPc: () => {
        throw new Error("no webrtc");
      },
    });
    expect(res).toMatchObject({ ok: false, outcome: "threw" });
    expect(String(res?.err)).toContain("no webrtc");
  });
});
