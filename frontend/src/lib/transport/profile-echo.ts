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

/**
 * Encoded profile frames, kept by what went into them.
 *
 * A room click or a resume asks whether any peer lacks our profile, and the
 * answer is the frame's hash - so the frame was built every time: avatar and
 * banner base64'd into it and the whole thing hashed, megabytes of work on
 * the main thread with an uploaded image, nearly always to find that every
 * peer already had it. A frame made of the same fields and the same image
 * bytes as one built before is that one. Only a few are kept - the main
 * frame, its reply form, a room or two with a profile of its own - since
 * each holds its images and its encoding.
 */
export class ProfileFrames {
  #frames = new Map<string, { images: ReadonlyArray<ArrayBuffer | undefined>; frame: Uint8Array; hash: number }>();

  constructor(private readonly max = 4) {}

  /**
   * The frame `build` makes, and its hash. `key` must name everything in it
   * but the image bytes; those are compared byte for byte.
   */
  get(key: string, images: ReadonlyArray<ArrayBuffer | undefined>,
    build: () => Uint8Array): { frame: Uint8Array; hash: number } {
    let entry = this.#frames.get(key);
    this.#frames.delete(key);
    if (!entry || entry.images.length !== images.length ||
        !entry.images.every((bytes, i) => sameBytes(bytes, images[i]))) {
      const frame = build();
      entry = { images, frame, hash: frameHash(frame) };
    }
    this.#frames.set(key, entry);
    if (this.#frames.size > this.max) this.#frames.delete(this.#frames.keys().next().value!);
    return entry;
  }
}

function sameBytes(a: ArrayBuffer | undefined, b: ArrayBuffer | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
