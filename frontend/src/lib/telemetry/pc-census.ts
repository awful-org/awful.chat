/**
 * How many `RTCPeerConnection`s this tab is holding open, right now.
 *
 * Chrome refuses the 500th with "Cannot create so many PeerConnections", and
 * a tab that reaches it loses EVERYTHING at once - voice, the SFU transports
 * and libp2p's own WebRTC dials all fail on the same line, so the first
 * symptom is never the cause. Nothing in the platform reports this number,
 * and no per-module counter can: the connections come from four independent
 * places (voice, mediasoup, libp2p, webtorrent) and three of them are inside
 * dependencies. The only vantage that sees all four is the constructor.
 *
 * So this wraps the global. That is a real cost and it is deliberate:
 *
 *   - The wrapper is a SUBCLASS, so `instanceof RTCPeerConnection` still
 *     holds and every method, property and event behaves as before.
 *   - It adds nothing to the instance except a private "already counted"
 *     flag, and it never inspects arguments, SDP or candidates.
 *   - It cannot throw into the caller: the count is updated inside a
 *     try/catch, and `close()` calls `super.close()` first.
 *
 * `live` counts what the BROWSER counts, which is not what is reachable: a
 * connection dropped without `close()` keeps its slot until it is collected,
 * and that is precisely the leak worth seeing. Only an explicit `close()` (or
 * the browser closing it itself) decrements.
 */

type PcCtor = typeof RTCPeerConnection;

interface Census {
  /** Open now: constructed and not yet closed. */
  live: number;
  /** Constructed since boot. A rebuild loop shows up here first. */
  created: number;
  /** The high-water mark of `live`. */
  peak: number;
  /** Whether the wrapper is in place; false in a context with no WebRTC. */
  installed: boolean;
}

let live = 0;
let created = 0;
let peak = 0;
let installed = false;
let native: PcCtor | null = null;

export function installPcCensus(): void {
  if (installed) return;
  const g = globalThis as unknown as { RTCPeerConnection?: PcCtor };
  const Native = g.RTCPeerConnection;
  // No WebRTC here at all: a test environment, or a browser that has it
  // disabled. Everything below stays a no-op and the gauge reads zero.
  if (typeof Native !== "function") return;

  class CountedPeerConnection extends Native {
    /** Guards the decrement: close() and the state change can both fire. */
    #counted = false;

    constructor(...args: ConstructorParameters<PcCtor>) {
      super(...args);
      try {
        this.#counted = true;
        created++;
        live++;
        if (live > peak) peak = live;
        // Covers the connections the browser closes on its own - a worker
        // teardown, a crashed process - which never reach close() below.
        this.addEventListener("connectionstatechange", () => {
          if (this.connectionState === "closed") this.#uncount();
        });
      } catch {
        // Counting must never break a connection the app needs.
      }
    }

    #uncount(): void {
      if (!this.#counted) return;
      this.#counted = false;
      live--;
    }

    close(): void {
      // The app's close comes first, always: if the count threw, the
      // connection would still have been closed.
      try {
        super.close();
      } finally {
        try {
          this.#uncount();
        } catch {
          // As above.
        }
      }
    }
  }

  native = Native;
  g.RTCPeerConnection = CountedPeerConnection as unknown as PcCtor;
  installed = true;
}

/** The current gauge. Safe to call at any time, including before install. */
export function pcCensus(): Census {
  return { live, created, peak, installed };
}

/** Restore the untouched global. For tests, and for a clean teardown. */
export function uninstallPcCensus(): void {
  if (!installed || !native) return;
  (globalThis as unknown as { RTCPeerConnection?: PcCtor }).RTCPeerConnection =
    native;
  native = null;
  installed = false;
  live = 0;
  created = 0;
  peak = 0;
}
