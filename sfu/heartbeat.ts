// Split out of index.ts so the backpressure deadline (finding 6) is
// unit-testable against controlled timestamps. Sustaining a real socket's
// `backpressured` flag for a specific duration through an actual byte flood
// is not a reliable test: local drain is fast enough that a burst clears in
// microseconds, nowhere near the seconds a genuinely stuck connection would
// take, so no fixed frame count is both fast and non-flaky. This module has
// no side effects on import, unlike index.ts (which starts a real mediasoup
// worker and listens on a port), so a test can import it directly.

/** Duck-typed subset of `WebSocket` the heartbeat sweep needs - lets a test
 *  drive the exact decision logic with a plain object instead of a real
 *  socket. */
export interface HeartbeatSocket {
  backpressured?: boolean;
  backpressuredSince?: number;
  isAlive?: boolean;
  ping(): void;
  terminate(): void;
}

/**
 * One connection's heartbeat decision. A connection paused for backpressure
 * cannot answer: ws.pause() pauses the underlying socket, so PONGS AND THE
 * CLOSE HANDSHAKE stop arriving along with the data frames. Treating that
 * silence as death would have this heartbeat terminate a peer for the crime
 * of sending too much - and it is the peers under real load that get
 * paused. They are demonstrably alive; that is why they were paused. But a
 * pause has to end sometime: one that is ALSO gone never drains on its own,
 * so past `backpressureDeadlineMs` this stops giving it the benefit of the
 * doubt.
 */
export function sweepHeartbeatConnection(
  w: HeartbeatSocket,
  now: number,
  backpressureDeadlineMs: number,
): EndedBy | null {
  if (w.backpressured) {
    if (
      w.backpressuredSince !== undefined &&
      now - w.backpressuredSince > backpressureDeadlineMs
    ) {
      w.terminate();
      return "backpressure";
    }
    return null;
  }
  if (w.isAlive === false) {
    w.terminate();
    return "heartbeat";
  } else {
    w.isAlive = false;
    w.ping();
    return null;
  }
}

/** Why the SFU itself cut a socket, when it was the one to do it. */
export type EndedBy = "heartbeat" | "backpressure" | "join-timeout" | "replaced";

/**
 * One log line's worth of why a session's socket closed. Every cut the SFU
 * makes is a terminate() - no close frame, so the socket reports 1006 just
 * like a connection the network or a proxy (Cloudflare) dropped - and none of
 * them used to say anything: "it closes after a while and nothing is in the
 * logs" could not be told apart from a crash. The cause is recorded where the
 * cut is made and read back here.
 */
export function describeClose(code: number, endedBy: EndedBy | undefined, seconds: number): string {
  const after = `after ${Math.round(seconds)}s`;
  switch (endedBy) {
    case "heartbeat":
      return `cut by the SFU: no answer to a heartbeat ping within the sweep interval (${after})`;
    case "backpressure":
      return `cut by the SFU: its send queue stayed full past the deadline (${after})`;
    case "join-timeout":
      return `cut by the SFU: never finished joining (${after})`;
    case "replaced":
      return `cut by the SFU: the same peer joined again and this session failed its liveness probe (${after})`;
  }
  if (code === 1000 || code === 1001) return `closed by the client (code ${code}, ${after})`;
  if (code === 1006) {
    return `dropped without a close frame - the network or a proxy in between (code 1006, ${after})`;
  }
  return `closed (code ${code}, ${after})`;
}
