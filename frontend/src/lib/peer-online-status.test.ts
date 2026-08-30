import { describe, it, expect } from "vitest";
import { derivePeerOnlineState, PEER_PROOF_GRACE_MS } from "./peer-online-status";

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
