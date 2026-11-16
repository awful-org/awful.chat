/**
 * Which DM calls this device took part in, by callId: what tells a card
 * "missed" from "ended" (call-card.ts). Device-local and bounded - a call
 * you took part in on another device reads as missed here, which is true of
 * this device.
 */
const KEY = "awful:dm-calls-joined:v1";
const MAX = 200;

function read(): string[] {
  try {
    const value = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

let joined = new Set(read());

export function noteDmCallJoined(callId: string): void {
  if (joined.has(callId)) return;
  const list = [...joined, callId].slice(-MAX);
  joined = new Set(list);
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    // Storage blocked: known for this session only.
  }
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
