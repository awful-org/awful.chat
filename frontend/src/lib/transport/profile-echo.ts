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

  /** Every record: a lock or a logout ends the session they were kept for. */
  clear(): void {
    this.#sent.clear();
    this.#held.clear();
  }
}

/**
 * Encoded profile frames, the last one built of each kind: the main frame
 * and each room's own, each plain and in its reply form.
 *
 * A room click or a resume asks whether any peer lacks our profile, and the
 * answer is the frame's hash - so the frame was built every time: avatar and
 * banner base64'd into it and the whole thing hashed, megabytes of work on
 * the main thread with an uploaded image, nearly always to find that every
 * peer already had it. A frame made of the same fields and the same image
 * bytes as the last of its kind is that one.
 *
 * One of each kind, rather than a few of any: a call asks for the main frame
 * and then each room's in turn, the same order every time, so once a call
 * needed more than were kept each one pushed out the next to be asked for,
 * and every frame was built again on every click. A change replaces the
 * frame of its kind instead of piling up beside it.
 */
export class ProfileFrames {
  /** By scope - "" for the main profile, else the room's code - then by form. */
  #frames = new Map<string, Map<boolean, {
    key: string; images: ReadonlyArray<ArrayBuffer | undefined>; frame: Uint8Array; hash: number;
  }>>();
  #generation = 0;

  /**
   * How many times clear() has run. A call that read the profile before a
   * lock passes the count it began with to get(), and so keeps nothing it
   * builds after the lock.
   */
  get generation(): number { return this.#generation; }

  /**
   * The frame `build` makes for `scope`, in its reply form or not, and its
   * hash. `key` must name everything in it but the image bytes; those are
   * compared byte for byte.
   */
  get(scope: string, reply: boolean, key: string, images: ReadonlyArray<ArrayBuffer | undefined>,
    build: () => Uint8Array, generation = this.#generation): { frame: Uint8Array; hash: number } {
    const last = this.#frames.get(scope)?.get(reply);
    if (last && last.key === key && last.images.length === images.length &&
        last.images.every((bytes, i) => sameBytes(bytes, images[i]))) return last;
    const frame = build();
    const built = { key, images, frame, hash: frameHash(frame) };
    if (generation === this.#generation) {
      let forms = this.#frames.get(scope);
      if (!forms) this.#frames.set(scope, forms = new Map());
      forms.set(reply, built);
    }
    return built;
  }

  /** Drop the frames of every scope not named: a room we have left needs none. */
  retain(scopes: Iterable<string>): void {
    const keep = new Set(scopes);
    for (const scope of [...this.#frames.keys()]) if (!keep.has(scope)) this.#frames.delete(scope);
  }

  /** Drop them all: a lock or a logout ends the session they were built for. */
  clear(): void {
    this.#frames.clear();
    this.#generation++;
  }
}

function sameBytes(a: ArrayBuffer | undefined, b: ArrayBuffer | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.byteLength !== b.byteLength) return false;
  const x = new Uint8Array(a), y = new Uint8Array(b);
  for (let i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
  return true;
}
