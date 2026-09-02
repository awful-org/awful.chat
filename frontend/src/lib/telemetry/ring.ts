/**
 * The flight recorder's storage: a bounded ring with a per-kind rate budget.
 *
 * Two properties are load-bearing and both are why this is not just an array:
 *
 * 1. Bounded memory. Recording is always on, from boot, for the life of the
 *    tab. An unbounded log is a leak.
 * 2. Bounded per KIND. Without the throttle, one hot kind (a message storm, an
 *    ICE state flap) evicts every rare event - and the rare events are the
 *    ones that name the bug.
 */

import { ev } from "./event";
import {
  DEFAULT_BUDGET,
  ERROR_BUDGET,
  KIND_BUDGET,
  type DiagEvent,
  type DiagKind,
} from "./schema";

export const RING_CAPACITY = 4096;

/** The throttle's fixed window. */
const WINDOW_MS = 1000;

export interface RingSnapshot {
  /** Oldest first. */
  events: DiagEvent[];
  dropped: number;
  suppressed: Record<string, number>;
  nextSeq: number;
}

export class DiagRing {
  readonly capacity: number;

  #buf: Array<DiagEvent | undefined>;
  #head = 0;
  #count = 0;
  #dropped = 0;
  #nextSeq = 1;

  /** Cumulative per-kind suppression counts, for the bundle envelope. */
  #suppressed: Record<string, number> = {};
  /** Suppressions not yet announced by a synthetic `meta.suppressed`. */
  #pending: Record<string, number> | null = null;
  /** The window start of the most recent suppression. */
  #pendingWindow = -1;

  #windows = new Map<DiagKind, { windowStart: number; count: number }>();
  #budgets: Readonly<Partial<Record<DiagKind, number>>>;

  constructor(
    capacity: number = RING_CAPACITY,
    budgets: Readonly<Partial<Record<DiagKind, number>>> = KIND_BUDGET
  ) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.#buf = new Array<DiagEvent | undefined>(this.capacity);
    this.#budgets = budgets;
  }

  get size(): number {
    return this.#count;
  }

  /**
   * Append an event.
   *
   * @param t milliseconds since the session started, integer
   * @param nowMs a monotonic clock for the throttle window
   * @returns false when the throttle suppressed it. Never throws.
   */
  push(e: Omit<DiagEvent, "seq" | "t">, t: number, nowMs: number): boolean {
    try {
      const budget =
        this.#budgets[e.kind] ??
        (e.sev === "error" ? ERROR_BUDGET : DEFAULT_BUDGET);

      let w = this.#windows.get(e.kind);
      if (!w || nowMs - w.windowStart >= WINDOW_MS) {
        w = { windowStart: nowMs, count: 0 };
        this.#windows.set(e.kind, w);
      }

      if (w.count >= budget) {
        this.#suppressed[e.kind] = (this.#suppressed[e.kind] ?? 0) + 1;
        if (!this.#pending) this.#pending = {};
        this.#pending[e.kind] = (this.#pending[e.kind] ?? 0) + 1;
        this.#pendingWindow = w.windowStart;
        return false;
      }
      w.count++;

      // A reader who has only the events - a log paste, a trimmed bundle -
      // must still see that a gap exists, so announce it inline once the
      // window that produced it has closed.
      if (this.#pending && nowMs - this.#pendingWindow >= WINDOW_MS) {
        const counts = this.#pending;
        this.#pending = null;
        this.#pendingWindow = -1;
        this.#write(ev("meta.suppressed", { d: counts }), t);
      }

      this.#write(e, t);
      return true;
    } catch {
      // The recorder never breaks the app.
      return false;
    }
  }

  snapshot(): RingSnapshot {
    const events: DiagEvent[] = [];
    const start = this.#count < this.capacity ? 0 : this.#head;
    for (let i = 0; i < this.#count; i++) {
      const e = this.#buf[(start + i) % this.capacity];
      if (e) events.push(e);
    }
    return {
      events,
      dropped: this.#dropped,
      suppressed: { ...this.#suppressed },
      nextSeq: this.#nextSeq,
    };
  }

  reset(): void {
    this.#buf = new Array<DiagEvent | undefined>(this.capacity);
    this.#head = 0;
    this.#count = 0;
    this.#dropped = 0;
    this.#nextSeq = 1;
    this.#suppressed = {};
    this.#pending = null;
    this.#pendingWindow = -1;
    this.#windows.clear();
  }

  #write(body: Omit<DiagEvent, "seq" | "t">, t: number): void {
    const full = this.#count === this.capacity;
    if (full) this.#dropped++;
    // Events are immutable once written, so `snapshot()` needs no copy.
    this.#buf[this.#head] = {
      ...body,
      seq: this.#nextSeq++,
      t: Math.round(t),
    } as DiagEvent;
    this.#head = (this.#head + 1) % this.capacity;
    if (!full) this.#count++;
  }
}
