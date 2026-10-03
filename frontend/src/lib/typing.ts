/**
 * Typing indicators: the timing on both ends, and the line the chat shows.
 *
 * Pure, so the clock is a parameter everywhere. typing.svelte.ts holds the
 * live instances, the timer and the preference; the transport only moves
 * the frames (WireTyping in types/message.ts).
 */

/** A sender repeats "typing" at most this often while the draft changes. */
export const TYPING_SEND_INTERVAL_MS = 3_000;

/**
 * A receiver forgets a typer this long after their last frame. Two send
 * intervals, so one lost frame does not blink the line off, and a closed tab
 * or a dropped connection - which never sends "stopped" - clears on its own.
 */
export const TYPING_TTL_MS = 6_000;

/** Names shown before the line switches to a count. */
export const TYPING_MAX_NAMES = 3;

/**
 * Typers tracked per conversation. Past the name limit only the count
 * matters, and a cap keeps a hostile room from growing the map without bound.
 */
export const MAX_TYPERS_PER_ROOM = 64;

export type TypingAction = "start" | "stop" | null;

/**
 * The sending half, one per composer. `input` runs on every change to the
 * draft and says what, if anything, to put on the wire.
 */
export class TypingSender {
  private active = false;
  private lastSent = 0;

  input(hasText: boolean, now: number): TypingAction {
    if (!hasText) return this.reset() ? "stop" : null;
    if (this.active && now - this.lastSent < TYPING_SEND_INTERVAL_MS) return null;
    this.active = true;
    this.lastSent = now;
    return "start";
  }

  /**
   * Forget the current burst without a frame of its own. After a send the
   * message itself clears the typer on the other end; after a conversation
   * switch the caller sends the "stop" to the room it is leaving.
   * True when a burst was in progress.
   */
  reset(): boolean {
    const was = this.active;
    this.active = false;
    this.lastSent = 0;
    return was;
  }
}

/**
 * A composer's whole sending side: the timing, plus where the current burst
 * was announced, so its "stop" reaches that conversation even after the
 * composer has moved on to another one.
 */
export class TypingAnnouncer<T> {
  private sender = new TypingSender();
  private target: T | null = null;

  constructor(private readonly send: (to: T, typing: boolean) => void) {}

  /**
   * On every change to the draft. `hasText` is false when there is nothing
   * to announce (an empty draft, or announcing is off). `resolve` names the
   * conversation, asked only when a frame is due; null means it cannot be
   * reached yet, and the next keystroke asks again.
   */
  input(hasText: boolean, now: number, resolve: () => T | null): void {
    const action = this.sender.input(hasText, now);
    if (action === "stop") return this.stop();
    if (action !== "start") return;
    const to = resolve();
    if (to === null) {
      this.sender.reset();
      return;
    }
    this.target = to;
    this.send(to, true);
  }

  /** Sent, emptied, or left: take the dots down now rather than on expiry. */
  stop(): void {
    this.sender.reset();
    if (this.target !== null) this.send(this.target, false);
    this.target = null;
  }
}

/**
 * The receiving half: who is typing where, and until when. Keyed by DID, so
 * one person on two devices is one typer.
 */
export class TypingTracker {
  /** room -> did -> expiry. Insertion order is the order people started. */
  private rooms = new Map<string, Map<string, number>>();

  /**
   * Record a frame. Returns true when the set of typers changed (someone
   * started), which is the only time the view needs to know: a repeat only
   * pushes an expiry out.
   */
  note(room: string, did: string, typing: boolean, now: number): boolean {
    if (!typing) return this.clear(room, did);
    let typers = this.rooms.get(room);
    if (typers?.has(did)) {
      typers.set(did, now + TYPING_TTL_MS);
      return false;
    }
    if (!typers) this.rooms.set(room, (typers = new Map()));
    if (typers.size >= MAX_TYPERS_PER_ROOM) return false;
    typers.set(did, now + TYPING_TTL_MS);
    return true;
  }

  /** Someone stopped, or their message arrived. True when they were listed. */
  clear(room: string, did: string): boolean {
    const typers = this.rooms.get(room);
    if (!typers?.delete(did)) return false;
    if (typers.size === 0) this.rooms.delete(room);
    return true;
  }

  /** Drop everyone whose time is up. True when anyone was dropped. */
  prune(now: number): boolean {
    let changed = false;
    for (const [room, typers] of this.rooms) {
      for (const [did, expires] of typers) {
        if (expires <= now) {
          typers.delete(did);
          changed = true;
        }
      }
      if (typers.size === 0) this.rooms.delete(room);
    }
    return changed;
  }

  /** Everyone typing in `room` right now, in the order they started. */
  typers(room: string, now: number): string[] {
    const typers = this.rooms.get(room);
    if (!typers) return [];
    return [...typers].filter(([, expires]) => expires > now).map(([did]) => did);
  }

  /** The soonest expiry anywhere, for the caller's one timer. */
  nextExpiry(): number | null {
    let next: number | null = null;
    for (const typers of this.rooms.values()) {
      for (const expires of typers.values()) {
        if (next === null || expires < next) next = expires;
      }
    }
    return next;
  }

  /** Lock, or a new identity: nobody from the old session is typing. */
  clearAll(): boolean {
    const had = this.rooms.size > 0;
    this.rooms.clear();
    return had;
  }
}

/**
 * The line under the messages: every name up to three, then a count.
 * Null when nobody is typing.
 */
export function typingLine(names: string[]): string | null {
  const n = names.length;
  if (n === 0) return null;
  if (n === 1) return `${names[0]} is typing…`;
  if (n > TYPING_MAX_NAMES) return `${n} people are typing…`;
  return `${names.slice(0, -1).join(", ")} and ${names[n - 1]} are typing…`;
}
