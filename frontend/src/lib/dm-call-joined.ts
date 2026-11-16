/**
 * Which DM calls this device took part in, by callId: what tells a card
 * "missed" from "ended" (call-card.ts). Device-local and bounded - a call
 * you took part in on another device reads as missed here, which is true of
 * this device - except across a device sync, which brings the other
 * device's list along (importDmCallsJoined).
 */
const KEY = "awful:dm-calls-joined:v1";
const MAX = 200;

function callIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((id): id is string => typeof id === "string" && id.length > 0 && id.length <= 128)
    : [];
}

function read(): string[] {
  try {
    return callIds(JSON.parse(localStorage.getItem(KEY) ?? "[]"));
  } catch {
    return [];
  }
}

let joined = new Set(read());

function keep(list: string[]): void {
  joined = new Set(list.slice(-MAX));
  try {
    localStorage.setItem(KEY, JSON.stringify([...joined]));
  } catch {
    // Storage blocked: known for this session only.
  }
}

export function noteDmCallJoined(callId: string): void {
  if (joined.has(callId)) return;
  keep([...joined, callId]);
}

/** Every call this device took part in, oldest first, for a device sync to carry. */
export function dmCallsJoined(): string[] {
  return [...joined];
}

/**
 * Take in another device's list. Device-local by nature, but a call taken on
 * the device you are syncing from is one you took part in, and without its
 * id the card here reads "missed". A merge keeps both lists within the same
 * bound, this device's entries last so they are the ones kept.
 */
export function importDmCallsJoined(ids: unknown, mode: "add" | "replace"): void {
  const incoming = callIds(ids);
  keep(mode === "replace" ? incoming : [...incoming.filter((id) => !joined.has(id)), ...joined]);
}

export function joinedDmCall(callId: string): boolean {
  return joined.has(callId);
}

/**
 * When this device saw each call start, by its own clock: the local time a
 * start card arrived live. A device that joins someone else's call measures
 * the call's length from here, not from the card's `at`, which is the
 * caller's clock. In memory only; bounded.
 */
const seenStart = new Map<string, number>();

export function noteCallStartSeen(callId: string, localAt: number): void {
  if (seenStart.has(callId)) return;
  seenStart.set(callId, localAt);
  if (seenStart.size > MAX) seenStart.delete(seenStart.keys().next().value as string);
}

export function callStartSeen(callId: string): number | undefined {
  return seenStart.get(callId);
}
