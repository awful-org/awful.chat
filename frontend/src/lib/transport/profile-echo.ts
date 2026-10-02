/**
 * Which peers already have our current profile.
 *
 * Its own module because it is pure: importing it must not drag the transport
 * and all of libp2p into a test that only wants to know whether a frame is a
 * duplicate.
 *
 * Every libp2p connection fires the app's connect handler, and a pair that
 * dials each other while also upgrading to direct ends up with two or three
 * at once. Each one sent our profile AND drew an unprovoked profile back,
 * which we answered with another - so a peer with an inline avatar arrived
 * six times in four seconds, 2.09 MB each, and ours went out just as often.
 * The burst is the problem, not the avatar: one copy is the point.
 */

/**
 * How long an identical profile counts as already delivered.
 *
 * Deliberately short. A peer that genuinely lost our profile is a peer that
 * reloaded, and a reload cannot return inside this window: the tab has to
 * boot, dial the relay and take a reservation, which the captures put at ten
 * seconds and up. What this drops is a copy the peer already holds, and the
 * 15s repair sweep re-sends unconditionally to any peer still unbound.
 */
export const PROFILE_ECHO_WINDOW_MS = 5_000;

/** FNV-1a over the encoded frame. Cheap next to framing and writing it. */
export function frameHash(bytes: Uint8Array): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/**
 * Per-peer, per-scope record of the last profile frame we sent, and of what
 * each peer was last delivered.
 */
export class ProfileEcho {
  #sent = new Map<string, Map<string, { hash: number; at: number }>>();
  /**
   * The content each peer holds, per scope, by hash. Unlike the burst window
   * this lasts until a send to them fails or they disconnect: a broadcast -
   * every room click, every network change - goes only to the peers that
   * lack the current profile, which when nothing changed is nobody.
   */
  #held = new Map<string, Map<string, number>>();

  constructor(private readonly windowMs: number = PROFILE_ECHO_WINDOW_MS) {}

  /** True if this frame should go out; records it when so. */
  shouldSend(peerId: string, hash: number, now: number = Date.now(), scope = ""): boolean {
    const scopes = this.#sent.get(peerId) ?? new Map();
    const last = scopes.get(scope);
    if (last?.hash === hash && now - last.at < this.windowMs) return false;
    scopes.set(scope, { hash, at: now });
    this.#sent.set(peerId, scopes);
    return true;
  }

  /** A send of this content reached the peer. */
  delivered(peerId: string, hash: number, scope = ""): void {
    const scopes = this.#held.get(peerId) ?? new Map();
    scopes.set(scope, hash);
    this.#held.set(peerId, scopes);
  }

  /** Whether the peer was last delivered exactly this content. */
  holds(peerId: string, hash: number, scope = ""): boolean {
    return this.#held.get(peerId)?.get(scope) === hash;
  }

  forget(peerId: string, scope?: string): void {
    if (scope === undefined) {
      this.#sent.delete(peerId);
      this.#held.delete(peerId);
    } else {
      this.#sent.get(peerId)?.delete(scope);
      this.#held.get(peerId)?.delete(scope);
    }
  }
}
