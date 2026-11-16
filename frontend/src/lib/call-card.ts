/**
 * The card a DM call leaves in the conversation.
 *
 * Whoever starts a call in a DM - joins it with nobody else in it - posts a
 * "start" card; whoever leaves it last posts an "end" card for the same call.
 * Both are ordinary signed chat rows (MessageType.CallEvent), so they arrive
 * the way any DM does, the mailbox included: someone offline finds the call
 * waiting as a message, and later learns how long it lasted, or that they
 * missed it. The view folds the end into its start: one card per call.
 *
 * DMs only, and no ringing (a decision, not a gap).
 */

export interface CallCardPayload {
  v: 1;
  /** Ties a call's start and end cards together. */
  callId: string;
  phase: "start" | "end";
  /** When this happened, by the poster's clock. */
  at: number;
}

const CALL_ID = /^[A-Za-z0-9_-]{8,64}$/;

export function newCallId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function encodeCallCard(payload: CallCardPayload): string {
  return JSON.stringify(payload);
}

/** A card's payload, or null for anything that is not one: rows are untrusted. */
export function parseCallCard(content: string): CallCardPayload | null {
  if (typeof content !== "string" || content.length > 256) return null;
  try {
    const value = JSON.parse(content) as Partial<CallCardPayload>;
    if (value?.v !== 1) return null;
    if (typeof value.callId !== "string" || !CALL_ID.test(value.callId)) return null;
    if (value.phase !== "start" && value.phase !== "end") return null;
    if (typeof value.at !== "number" || !Number.isFinite(value.at) || value.at <= 0) return null;
    return { v: 1, callId: value.callId, phase: value.phase, at: value.at };
  } catch {
    return null;
  }
}

export interface CallCardRow {
  id: string;
  type: string;
  content: string;
  senderId: string;
}

type CallCardEntry<T> = { row: T; card: CallCardPayload };

export interface CallCardFold<T> {
  calls: Map<string, { start?: CallCardEntry<T>; end?: CallCardEntry<T> }>;
  /** End rows folded into a start shown elsewhere: the view draws nothing for them. */
  foldedEnds: Set<string>;
  /** A start row's id -> its call's end card. */
  endOf: Map<string, CallCardPayload>;
  /**
   * The newest started call with no end card yet: the only one a call going
   * on right now can be. Older open starts lost their end (a closed tab, a
   * crash) and are over.
   */
  open: CallCardEntry<T> | null;
}

/**
 * Each call's start and end, by callId, and the end rows that fold into a
 * start shown elsewhere. An end whose start is not held stands as its own card.
 */
export function foldCallCards<T extends CallCardRow>(
  rows: readonly T[],
  callEventType: string,
): CallCardFold<T> {
  const calls = new Map<string, { start?: CallCardEntry<T>; end?: CallCardEntry<T> }>();
  const endRows: CallCardEntry<T>[] = [];
  for (const row of rows) {
    if (row.type !== callEventType) continue;
    const card = parseCallCard(row.content);
    if (!card) continue;
    const entry = calls.get(card.callId) ?? {};
    if (card.phase === "start") {
      if (!entry.start) entry.start = { row, card };
    } else {
      endRows.push({ row, card });
      // Two people leaving at once can both post an end: the earliest wins.
      if (!entry.end || card.at < entry.end.card.at) entry.end = { row, card };
    }
    calls.set(card.callId, entry);
  }
  // Every end row of a call whose start is held folds, duplicates included.
  const foldedEnds = new Set<string>();
  for (const { row, card } of endRows) {
    if (calls.get(card.callId)?.start) foldedEnds.add(row.id);
  }
  const endOf = new Map<string, CallCardPayload>();
  let newest: CallCardEntry<T> | null = null;
  for (const { start, end } of calls.values()) {
    if (!start) continue;
    if (end) endOf.set(start.row.id, end.card);
    if (!newest || start.card.at > newest.card.at) newest = start;
  }
  const open = newest && !calls.get(newest.card.callId)?.end ? newest : null;
  return { calls, foldedEnds, endOf, open };
}

/** "45 s", "12 min", "1 h 5 min". */
export function formatCallDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  return min % 60 ? `${h} h ${min % 60} min` : `${h} h`;
}

export type CallCardState =
  | { kind: "ongoing"; since: number }
  | { kind: "ended"; duration: number }
  /** Ended with no end card (the last one out never posted it). */
  | { kind: "ended-unknown" }
  | { kind: "missed" };

/**
 * What one call's card says. `ongoing`: somebody is in a call in this DM
 * right now. `joined`: this device took part (never "missed" then), and
 * `mine`: this side started it.
 */
export function callCardState(opts: {
  start?: CallCardPayload;
  end?: CallCardPayload;
  ongoing: boolean;
  joined: boolean;
  mine: boolean;
}): CallCardState {
  const { start, end, ongoing, joined, mine } = opts;
  if (!end && ongoing && start) return { kind: "ongoing", since: start.at };
  if (!joined && !mine) return { kind: "missed" };
  if (start && end) return { kind: "ended", duration: Math.max(0, end.at - start.at) };
  return { kind: "ended-unknown" };
}

/** A one-line description, for the DM list preview and notifications. */
export function callCardSummary(card: CallCardPayload | null): string {
  if (!card) return "Call";
  return card.phase === "start" ? "Started a call" : "Call ended";
}
