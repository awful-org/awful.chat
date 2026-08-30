import { describe, expect, it, vi } from "vitest";
import { createHostDepartureGrace, HOST_DEPARTURE_GRACE_MS } from "./host-departure";

const HOST = "did:host";

describe("createHostDepartureGrace", () => {
  it("does nothing while the host stays connected", () => {
    vi.useFakeTimers();
    try {
      const onGraceElapsed = vi.fn();
      const grace = createHostDepartureGrace(HOST, () => [{ did: HOST }], onGraceElapsed);
      grace.observePeers();
      vi.advanceTimersByTime(HOST_DEPARTURE_GRACE_MS + 1_000);
      expect(onGraceElapsed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes the party once the host has been gone for the whole grace window", () => {
    vi.useFakeTimers();
    try {
      const onGraceElapsed = vi.fn();
      let peers: Array<{ did: string }> = [{ did: HOST }];
      const grace = createHostDepartureGrace(HOST, () => peers, onGraceElapsed);
      peers = [];
      grace.observeDisconnect(HOST);
      expect(onGraceElapsed).not.toHaveBeenCalled();
      vi.advanceTimersByTime(HOST_DEPARTURE_GRACE_MS - 1);
      expect(onGraceElapsed).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1);
      expect(onGraceElapsed).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancels the close when the host reconnects before the grace window elapses", () => {
    vi.useFakeTimers();
    try {
      const onGraceElapsed = vi.fn();
      let peers: Array<{ did: string }> = [{ did: HOST }];
      const grace = createHostDepartureGrace(HOST, () => peers, onGraceElapsed);
      peers = [];
      grace.observeDisconnect(HOST);
      vi.advanceTimersByTime(HOST_DEPARTURE_GRACE_MS / 2);
      // The host's peer connection comes back before the window elapses.
      peers = [{ did: HOST }];
      grace.observePeers();
      vi.advanceTimersByTime(HOST_DEPARTURE_GRACE_MS);
      expect(onGraceElapsed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a disconnect for anyone other than the host", () => {
    vi.useFakeTimers();
    try {
      const onGraceElapsed = vi.fn();
      const grace = createHostDepartureGrace(HOST, () => [], onGraceElapsed);
      grace.observeDisconnect("did:someone-else");
      vi.advanceTimersByTime(HOST_DEPARTURE_GRACE_MS + 1_000);
      expect(onGraceElapsed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("dispose leaves no pending timer that can still fire", () => {
    vi.useFakeTimers();
    try {
      const onGraceElapsed = vi.fn();
      const grace = createHostDepartureGrace(HOST, () => [], onGraceElapsed);
      grace.observeDisconnect(HOST);
      grace.dispose();
      vi.advanceTimersByTime(HOST_DEPARTURE_GRACE_MS + 1_000);
      expect(onGraceElapsed).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
