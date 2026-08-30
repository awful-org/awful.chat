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
): void {
  if (w.backpressured) {
    if (
      w.backpressuredSince !== undefined &&
      now - w.backpressuredSince > backpressureDeadlineMs
    ) {
      w.terminate();
    }
    return;
  }
  if (w.isAlive === false) {
    w.terminate();
  } else {
    w.isAlive = false;
    w.ping();
  }
}
