/**
 * Live typing indicators: who is typing in each conversation, and whether
 * this device tells anyone when WE are.
 *
 * The preference only gates sending. Turning it off still shows everyone
 * else, the way Discord does it. Device-local, like display-prefs.
 */

import { onIdentityLock } from "./identity/lock-events";
import { TypingTracker } from "./typing";

const SEND_TYPING_KEY = "awful:send-typing:v1";

function readSendTyping(): boolean {
  if (typeof localStorage === "undefined") return true;
  try {
    return localStorage.getItem(SEND_TYPING_KEY) !== "0";
  } catch {
    return true;
  }
}

export const typingPrefs = $state({
  /** Tell the conversation when you are typing. */
  sendTyping: readSendTyping(),
});

export function setSendTyping(on: boolean): void {
  typingPrefs.sendTyping = on;
  try {
    localStorage.setItem(SEND_TYPING_KEY, on ? "1" : "0");
  } catch {
    // Storage blocked: the choice just does not survive a reload.
  }
}

const tracker = new TypingTracker();

/**
 * Bumped whenever the set of typers changes. Readers pass it through so
 * Svelte re-reads the tracker, which is a plain class and not reactive.
 */
export const typingState = $state({ version: 0 });

let timer: ReturnType<typeof setTimeout> | null = null;

function changed(): void {
  typingState.version += 1;
  schedule();
}

/** One timer for everyone: it fires at the soonest expiry and re-arms. */
function schedule(): void {
  if (timer) clearTimeout(timer);
  timer = null;
  const next = tracker.nextExpiry();
  if (next === null) return;
  timer = setTimeout(() => {
    timer = null;
    if (tracker.prune(Date.now())) typingState.version += 1;
    schedule();
  }, Math.max(0, next - Date.now()));
}

/** A typing frame arrived from `did` over `room`'s channel. */
export function noteTyping(room: string, did: string, typing: boolean): void {
  if (tracker.note(room, did, typing, Date.now())) changed();
}

/** `did` just sent a message in `room`: the message replaces the dots. */
export function clearTyping(room: string, did: string): void {
  if (tracker.clear(room, did)) changed();
}

/** DIDs typing in `room`, in the order they started. */
export function typersIn(room: string): string[] {
  void typingState.version;
  return tracker.typers(room, Date.now());
}

onIdentityLock(() => {
  if (tracker.clearAll()) changed();
});

// A second tab flipping the switch should be reflected here, not fought.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === SEND_TYPING_KEY) typingPrefs.sendTyping = e.newValue !== "0";
  });
}
