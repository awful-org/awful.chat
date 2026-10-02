// Rate limiting for the inbound sync surface, lifted out of
// transport.svelte.ts so it can be tested (that module builds a libp2p node
// at import time).
//
// Every expensive REACTION to a peer's frame goes through here: a digest
// making us decrypt and push history (inline attachment bytes included), a
// forged "you are behind" making us reply, a bare SyncComplete making us
// fan a digest out to the whole room. All of them were unthrottled: our own
// outbound digests debounce, but a room member looping a few-hundred-byte
// frame could make us re-run the reaction at line rate - bandwidth and CPU
// amplification behind the membership boundary.
//
// A hard window, deliberately without a "their watermarks changed" bypass:
// any bypass condition is attacker-controlled (vary one invented sender per
// frame) and would defeat the throttle entirely. Honest flows fit the
// window - one push hands over everything missing, and the repair tick is
// slower than this.
export const SYNC_REACTION_MIN_MS = 10_000;

const _lastReactionAt = new Map<string, number>();

/**
 * True (and records the reaction) when `key` has not reacted inside the
 * window. Key by reaction kind plus its scope, e.g. `push|<peer>|<room>`,
 * `reply|<peer>|<room>`, `fanout|<room>`.
 */
export function allowSyncReaction(key: string, now = Date.now()): boolean {
  const at = _lastReactionAt.get(key);
  if (at !== undefined && now - at < SYNC_REACTION_MIN_MS) return false;
  _lastReactionAt.set(key, now);
  return true;
}

/** Test seam. */
export function _resetSyncThrottle(): void {
  _lastReactionAt.clear();
}

/**
 * The repair tick's digests to a peer, per room, back off while every
 * exchange finds nothing missing either way. A quiet pair of members
 * otherwise traded a digest every 15s for as long as both stayed open, and
 * each one cost the receiver a read of the room. 15s, 30s, ... up to 5
 * minutes; anything that shows the room moving (a message, a push, an
 * exchange that found a difference) starts it over. Event-driven digests -
 * a connect, a gap, a resync - never wait on this.
 */
export const REPAIR_BACKOFF_MIN_MS = 15_000;
export const REPAIR_BACKOFF_MAX_MS = 5 * 60_000;

export class RepairBackoff {
  private waits = new Map<string, { next: number; delay: number }>();

  /** May the tick send this peer a digest for this room now? */
  due(peer: string, room: string, now = Date.now()): boolean {
    return now >= (this.waits.get(`${peer}|${room}`)?.next ?? 0);
  }

  /** A digest went out, or an exchange found nothing: wait longer next time. */
  wait(peer: string, room: string, now = Date.now()): void {
    const key = `${peer}|${room}`;
    const at = this.waits.get(key) ?? { next: 0, delay: 0 };
    at.delay = Math.min(Math.max(at.delay * 2, REPAIR_BACKOFF_MIN_MS), REPAIR_BACKOFF_MAX_MS);
    at.next = now + at.delay;
    this.waits.set(key, at);
  }

  /** The room moved: the next quiet spell starts at the shortest wait. */
  reset(peer: string, room: string): void {
    this.waits.delete(`${peer}|${room}`);
  }

  forgetPeer(peer: string): void {
    for (const key of this.waits.keys()) {
      if (key.startsWith(`${peer}|`)) this.waits.delete(key);
    }
  }
}
