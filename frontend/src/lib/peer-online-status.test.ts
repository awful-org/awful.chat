import { describe, it, expect } from "vitest";
import {
  derivePeerOnlineState,
  nextGraceExpiry,
  PEER_PROOF_GRACE_MS,
} from "./peer-online-status";

describe("derivePeerOnlineState", () => {
  it("is fully offline when not connected at all", () => {
    const state = derivePeerOnlineState(false, false, undefined, 0, PEER_PROOF_GRACE_MS);
    expect(state).toEqual({ isOnline: false, isConnecting: false });
  });

  it("is online immediately once the stream is proven", () => {
    const state = derivePeerOnlineState(true, true, 0, 0, PEER_PROOF_GRACE_MS);
    expect(state).toEqual({ isOnline: true, isConnecting: false });
  });

  it("reads online, not connecting, inside the grace window with no proof yet", () => {
    // Regression for libp2p-audit finding 1's UI half: a peer connected
    // 1s ago with no proof yet must not flicker to "Connecting" - the
    // ordinary handshake has not had time to confirm.
    const state = derivePeerOnlineState(
      true,
      false,
      1000,
      2000,
      PEER_PROOF_GRACE_MS
    );
    expect(state).toEqual({ isOnline: true, isConnecting: false });
  });

  it("downgrades to connecting once the grace window elapses with no proof", () => {
    const state = derivePeerOnlineState(
      true,
      false,
      0,
      PEER_PROOF_GRACE_MS + 1,
      PEER_PROOF_GRACE_MS
    );
    expect(state).toEqual({ isOnline: false, isConnecting: true });
  });

  it("regression: a peer connected with zero proof and no grace start never renders as plain online", () => {
    // This is libp2p-audit finding 1 exactly: connectedPeers gained the peer
    // with no proof check at all. connectedSinceMs undefined means the
    // caller never observed a connect for this peer - it must not default
    // to "online".
    const state = derivePeerOnlineState(
      true,
      false,
      undefined,
      1_000_000,
      PEER_PROOF_GRACE_MS
    );
    expect(state.isOnline).toBe(false);
    expect(state.isConnecting).toBe(true);
  });

  it("treats exactly the grace boundary as still within grace", () => {
    const state = derivePeerOnlineState(
      true,
      false,
      0,
      PEER_PROOF_GRACE_MS - 1,
      PEER_PROOF_GRACE_MS
    );
    expect(state.isOnline).toBe(true);
  });
});

describe("nextGraceExpiry", () => {
  const grace = PEER_PROOF_GRACE_MS;

  it("has nothing to wake for when every connected peer is proven", () => {
    // The member list used to tick twice a second regardless, rebuilding
    // the whole roster each time. With everyone proven, no state can change
    // with time alone, so there must be no clock running at all.
    const since = new Map([["a", 0], ["b", 500]]);
    expect(nextGraceExpiry(since, new Set(["a", "b"]), 600, grace)).toBeNull();
  });

  it("wakes at the end of an unproven peer's grace window", () => {
    const since = new Map([["a", 1000]]);
    expect(nextGraceExpiry(since, new Set(), 1500, grace)).toBe(1000 + grace);
  });

  it("picks the earliest window still running", () => {
    const since = new Map([["late", 2000], ["early", 1000], ["proven", 0]]);
    expect(nextGraceExpiry(since, new Set(["proven"]), 1500, grace)).toBe(
      1000 + grace
    );
  });

  it("forgets a window that has already run out", () => {
    // Already "connecting" at this time: nothing more happens to it.
    const since = new Map([["a", 0]]);
    expect(nextGraceExpiry(since, new Set(), grace, grace)).toBeNull();
  });

  it("agrees with derivePeerOnlineState on when the state flips", () => {
    const since = 1000;
    const at = nextGraceExpiry(new Map([["a", since]]), new Set(), since, grace)!;
    expect(derivePeerOnlineState(true, false, since, at - 1, grace).isOnline).toBe(true);
    expect(derivePeerOnlineState(true, false, since, at, grace).isConnecting).toBe(true);
  });
});
