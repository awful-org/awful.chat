/**
 * Message search engine: corpus entries, filter matching, ranking.
 *
 * Pure module - no storage, no UI, no $state - so the whole pipeline is
 * unit-testable. Terms match at word starts (wordStartAt), quoted
 * phrases anywhere; only the short sender name in from: stays fuzzy.
 */
import { MessageType, type ChatMessageType } from "$lib/types/message";
import { match, mergeRanges, type MatchRange } from "$lib/palette/scorer";
import type { SearchQuery, SearchTerm } from "./query";
import { linkTargets, stripMarkdown } from "$lib/markdown";

// Kind flags, matched by the has: filter.
export const HAS_FILE = 1;
export const HAS_IMAGE = 2;
export const HAS_VIDEO = 4;
export const HAS_AUDIO = 8;
export const HAS_GIF = 16;
export const HAS_LINK = 32;

export interface SearchEntry {
  id: string;
  roomCode: string;
  lamport: number;
  timestamp: number;
  senderDid: string;
  senderName: string;
  /** Original-case searchable text: content, filenames, plugin name. */
  text: string;
  /** Lowercased once at build time - lowercasing per keystroke is the cost
   *  the palette scorer's own comments warn about. */
  low: string;
  flags: number;
}

const SEARCHABLE: ReadonlySet<ChatMessageType> = new Set([
  MessageType.Text,
  MessageType.Reply,
  MessageType.File,
  MessageType.PluginCard,
]);

const LINK_RE = /(https?:\/\/|www\.)\S/i;

/** The subset of Message the entry builder reads. */
export interface SearchableMessage {
  id: string;
  roomCode: string;
  lamport: number;
  timestamp: number;
  senderId: string;
  senderDid?: string;
  senderName: string;
  type: ChatMessageType;
  content: string;
  meta?: {
    files?: Array<{ filename?: string; mimeType?: string }>;
  };
}

/**
 * Build a corpus entry, or null for message types search does not cover.
 * `pluginName` resolves a pluginId to its display name so "waffle party"
 * finds the card; the registry lookup stays with the caller.
 */
export function entryFromMessage(
  msg: SearchableMessage,
  pluginName?: (pluginId: string) => string | undefined
): SearchEntry | null {
  if (!SEARCHABLE.has(msg.type)) return null;
  const content = typeof msg.content === "string" ? msg.content : "";

  let text = "";
  let flags = 0;

  if (msg.type !== MessageType.PluginCard) {
    // What the message reads as, markup dropped: "**launch**" is found by
    // "launch", and a snippet does not show the asterisks.
    text = [stripMarkdown(content), ...linkTargets(content)].filter(Boolean).join(" ");
  } else {
    // A malformed card still yields an (empty) entry: the sealed index's
    // coverage check compares entry count against the searchable ROW count,
    // and a searchable row with no entry would read as a gap forever.
    let pluginId = "";
    try {
      const parsed = JSON.parse(content) as { pluginId?: string };
      if (typeof parsed.pluginId === "string") pluginId = parsed.pluginId;
    } catch {
      // Fall through with an empty pluginId.
    }
    text = (pluginId && pluginName?.(pluginId)) || pluginId;
  }

  if (msg.type === MessageType.File) {
    flags |= HAS_FILE;
    const names: string[] = [];
    for (const file of msg.meta?.files ?? []) {
      if (file.filename) names.push(file.filename);
      const mime = file.mimeType ?? "";
      if (mime === "image/gif") flags |= HAS_GIF;
      if (mime.startsWith("image/")) flags |= HAS_IMAGE;
      if (mime.startsWith("video/")) flags |= HAS_VIDEO;
      if (mime.startsWith("audio/")) flags |= HAS_AUDIO;
    }
    if (names.length) text = text ? `${text} ${names.join(" ")}` : names.join(" ");
  }

  if (LINK_RE.test(content)) flags |= HAS_LINK;

  return {
    id: msg.id,
    roomCode: msg.roomCode,
    lamport: msg.lamport,
    timestamp: msg.timestamp,
    senderDid: msg.senderDid || msg.senderId,
    senderName: msg.senderName,
    text,
    low: text.toLowerCase(),
    flags,
  };
}

export interface SearchHit {
  entry: SearchEntry;
  /** Rank score: match quality x recency decay. Comparable within one query. */
  score: number;
  /** Merged highlight ranges into `entry.text`. */
  ranges: MatchRange[];
}

const WORD_CHAR = /[\p{L}\p{N}_]/u;
/** Scripts written without spaces: there is no word start to anchor on. */
const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;

// A match scores the way the palette's matchExact scores a run of characters:
// RUN_SCORE each, plus START_BONUS when the run opens the text. Spelled out
// here so the ranking pass can score without building the positions array
// matchExact returns - on a one-letter query that array was built for most
// of the corpus and thrown away for all but the best 80.
const RUN_SCORE = 16;
const START_BONUS = 20;
/** Per character, on top, for a term that is a whole word. */
const WHOLE_WORD_SCORE = 8;

/**
 * Where an unquoted term matches: the first WORD that begins with it. "dep"
 * finds "deploy", "ploy" does not, and neither do letters that merely occur
 * in order somewhere. This used the palette's fuzzy scorer, which is right
 * for a few dozen short titles and wrong for message text - a paragraph
 * contains almost any handful of letters in order, so most of a room
 * matched. Scored like matchExact, plus a bonus for the whole word
 * (termScoreAt).
 */
function wordStartAt(lowText: string, lowTerm: string): number {
  if (lowTerm.length === 0) return -1;
  if (UNSPACED.test(lowTerm[0])) return lowText.indexOf(lowTerm);
  for (let at = lowText.indexOf(lowTerm); at >= 0; at = lowText.indexOf(lowTerm, at + 1)) {
    if (at > 0 && WORD_CHAR.test(lowText[at - 1])) continue;
    return at;
  }
  return -1;
}

function termAt(lowText: string, term: SearchTerm): number {
  if (!term.exact) return wordStartAt(lowText, term.text);
  return term.text.length === 0 ? -1 : lowText.indexOf(term.text);
}

function termScoreAt(lowText: string, term: SearchTerm, at: number): number {
  const lowTerm = term.text;
  const run = RUN_SCORE * lowTerm.length;
  if (term.exact || UNSPACED.test(lowTerm[0])) {
    return run + (at === 0 ? START_BONUS : 0);
  }
  // A word start counts as the start of a run: it was scored on the text
  // from that word on.
  const end = at + lowTerm.length;
  const wholeWord = end === lowText.length || !WORD_CHAR.test(lowText[end]);
  return run + START_BONUS + (wholeWord ? lowTerm.length * WHOLE_WORD_SCORE : 0);
}

/** Recency half-life: a hit ages to half its score every 30 days. */
const HALF_LIFE_MS = 30 * 24 * 60 * 60 * 1000;

/** Whether an entry passes a from: filter. */
type FromFilter = (entry: SearchEntry, from: string) => boolean;

function fromMatches(entry: SearchEntry, from: string): boolean {
  return (
    match(entry.senderName.toLowerCase(), from) !== null ||
    entry.senderDid.toLowerCase().startsWith(from)
  );
}

/**
 * The from: filter for one search, remembered per name and per DID: a room
 * holds thousands of messages from a handful of people, and the fuzzy name
 * match lowercased and scored the same name once per message.
 */
function rememberingFromFilter(): FromFilter {
  const byName = new Map<string, boolean>();
  const byDid = new Map<string, boolean>();
  return (entry, from) => {
    let name = byName.get(entry.senderName);
    if (name === undefined) {
      name = match(entry.senderName.toLowerCase(), from) !== null;
      byName.set(entry.senderName, name);
    }
    if (name) return true;
    let did = byDid.get(entry.senderDid);
    if (did === undefined) {
      did = entry.senderDid.toLowerCase().startsWith(from);
      byDid.set(entry.senderDid, did);
    }
    return did;
  };
}

/**
 * The rank score of one entry, or -1 when any filter or term fails. Builds
 * nothing: ranking a corpus calls this once per entry, and only the hits
 * that make the cut are turned into SearchHits (searchEntries).
 */
export function scoreEntry(
  entry: SearchEntry,
  q: SearchQuery,
  nowMs: number,
  passesFrom: FromFilter = fromMatches
): number {
  if ((entry.flags & q.has) !== q.has) return -1;
  if (q.before !== null && entry.timestamp >= q.before) return -1;
  if (q.after !== null && entry.timestamp < q.after) return -1;
  if (q.from !== null && !passesFrom(entry, q.from)) return -1;

  let termScore = 0;
  for (const term of q.terms) {
    const at = termAt(entry.low, term);
    if (at < 0) return -1;
    termScore += termScoreAt(entry.low, term, at);
  }

  // A timestamp that is not a number (it comes from the sender) ages to
  // nothing rather than to NaN, which no ranking can order.
  const age = Math.max(0, nowMs - entry.timestamp) || 0;
  return (1 + termScore) * Math.pow(2, -age / HALF_LIFE_MS);
}

/** Highlight ranges for an entry the query matches. */
function rangesFor(entry: SearchEntry, q: SearchQuery): MatchRange[] {
  const ranges: MatchRange[] = [];
  for (const term of q.terms) {
    const at = termAt(entry.low, term);
    if (at >= 0) ranges.push({ start: at, end: at + term.text.length });
  }
  return mergeRanges(ranges);
}

/**
 * Match one entry against a parsed query. Null when any filter or term
 * fails. Zero terms with a filter is valid ("has:image") and ranks purely
 * by recency.
 *
 * Searching does not go through here: searchEntries scores every entry and
 * builds a hit only for those that make the cut. This is the one-entry
 * form the tests hold searchEntries to.
 */
export function matchEntry(
  entry: SearchEntry,
  q: SearchQuery,
  nowMs: number
): SearchHit | null {
  const score = scoreEntry(entry, q, nowMs);
  if (score < 0) return null;
  return { entry, score, ranges: rangesFor(entry, q) };
}

interface Ranked {
  entry: SearchEntry;
  score: number;
  /** Scan order: what a stable sort would keep first among exact ties. */
  seq: number;
}

/** Whether `a` ranks below `b`: by score, then the newer (higher lamport)
 *  first, then scan order. */
function ranksBelow(a: Ranked, b: Ranked): boolean {
  if (a.score !== b.score) return a.score < b.score;
  if (a.entry.lamport !== b.entry.lamport) return a.entry.lamport < b.entry.lamport;
  return a.seq > b.seq;
}

/**
 * The best `limit` hits across the given entry lists, best first - the same
 * list and order as matching every entry (matchEntry) and stable-sorting
 * all the hits by score, recency breaking ties.
 *
 * It keeps a heap of the best `limit` instead: a one-letter query matches
 * most of every room, and sorting all of those hits, each with its own
 * ranges array, to show 80 of them was most of the cost of a keystroke.
 */
export function searchEntries(
  lists: Iterable<readonly SearchEntry[]>,
  q: SearchQuery,
  limit: number,
  nowMs: number
): SearchHit[] {
  if (limit <= 0) return [];
  const passesFrom = rememberingFromFilter();
  // A min-heap on rank: the root is the weakest hit kept so far.
  const heap: Ranked[] = [];
  let seq = 0;
  for (const entries of lists) {
    for (const entry of entries) {
      const score = scoreEntry(entry, q, nowMs, passesFrom);
      const at = seq++;
      if (score < 0) continue;
      const item = { entry, score, seq: at };
      if (heap.length < limit) {
        heap.push(item);
        siftUp(heap, heap.length - 1);
      } else if (ranksBelow(heap[0], item)) {
        heap[0] = item;
        siftDown(heap, 0);
      }
    }
  }
  heap.sort((a, b) => (ranksBelow(a, b) ? 1 : ranksBelow(b, a) ? -1 : 0));
  return heap.map((r) => ({ entry: r.entry, score: r.score, ranges: rangesFor(r.entry, q) }));
}

function siftUp(heap: Ranked[], i: number): void {
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (!ranksBelow(heap[i], heap[parent])) return;
    [heap[i], heap[parent]] = [heap[parent], heap[i]];
    i = parent;
  }
}

function siftDown(heap: Ranked[], i: number): void {
  for (;;) {
    const left = 2 * i + 1;
    const right = left + 1;
    let weakest = i;
    if (left < heap.length && ranksBelow(heap[left], heap[weakest])) weakest = left;
    if (right < heap.length && ranksBelow(heap[right], heap[weakest])) weakest = right;
    if (weakest === i) return;
    [heap[i], heap[weakest]] = [heap[weakest], heap[i]];
    i = weakest;
  }
}

export interface Snippet {
  /** Slice of entry.text around the first match. */
  text: string;
  /** Highlight ranges rebased into `text`. */
  ranges: MatchRange[];
  leading: boolean;
  trailing: boolean;
}

const SNIPPET_CHARS = 120;

/** Window the text around the first highlight so the match is visible. */
export function snippetFor(entry: SearchEntry, ranges: MatchRange[]): Snippet {
  const full = entry.text;
  if (full.length <= SNIPPET_CHARS || ranges.length === 0) {
    const text = full.slice(0, SNIPPET_CHARS);
    return {
      text,
      ranges: ranges.filter((r) => r.start < text.length).map((r) => ({
        start: r.start,
        end: Math.min(r.end, text.length),
      })),
      leading: false,
      trailing: full.length > SNIPPET_CHARS,
    };
  }
  const anchor = ranges[0].start;
  let start = Math.max(0, anchor - Math.floor(SNIPPET_CHARS / 3));
  // Snap to a word boundary so the snippet does not open mid-word.
  const space = full.lastIndexOf(" ", start);
  if (space > 0 && start - space < 16) start = space + 1;
  const end = Math.min(full.length, start + SNIPPET_CHARS);
  return {
    text: full.slice(start, end),
    ranges: ranges
      .filter((r) => r.end > start && r.start < end)
      .map((r) => ({
        start: Math.max(0, r.start - start),
        end: Math.min(end - start, r.end - start),
      })),
    leading: start > 0,
    trailing: end < full.length,
  };
}
