// The sending end of a history push, lifted out of transport.svelte.ts so it
// can be tested: that module builds a libp2p node at import time.
//
// A push used to fire every batch at once, newest first, without looking at
// what the room channel answered. The channel refuses past 32 frames (or
// 4 MB) in flight, so every batch past about the 32nd was dropped - the
// SyncComplete behind them too - while the receiver had already claimed
// watermarks up to the newest rows it did get. Nobody ever offered the
// older rows again: anyone joining or coming back to a room more than about
// 640 rows behind kept a permanent hole in its history, silently.
//
// The push is shaped here instead:
//  - the newest page goes first ("head"), so the receiver's screen fills at
//    once, as it did;
//  - everything else follows OLDEST first ("asc"), so whatever prefix of it
//    arrives leaves no gap below it and a push cut short still counts;
//  - each batch goes out only once the previous one was accepted, at a pace
//    an older receiver - which verifies a batch before reading the next frame
//    off the channel - can keep up with. A refusal is retried, then ends the
//    push; SyncComplete goes out only when every batch was accepted.
import { MessageType } from "$lib/types/message";
import { compareMessages } from "./message-order";

export type PushOrder = "head" | "asc";

export interface PushBatch<T> {
  rows: T[];
  order: PushOrder;
}

export interface PushPlan<T> {
  /** Rows per batch. */
  batchSize: number;
  /** Rows the receiver's first screen shows; the head covers that many. */
  pageSize: number;
  /** A batch closes early once it carries this many bytes. */
  maxBatchBytes: number;
  sizeOf: (row: T) => number;
}

/**
 * The batches of one push: the newest page first, newest row first, then
 * everything older, oldest row first. A push that fits on one screen has no
 * head - it is all "asc".
 */
export function planPush<T extends { id: string; lamport: number; type: string }>(
  rows: T[],
  plan: PushPlan<T>
): PushBatch<T>[] {
  const sorted = [...rows].sort(compareMessages);
  // The page the receiver renders skips plugin updates, so the head runs
  // back to the pageSize-th row it would show, and takes every update in
  // between: a head that stopped short would leave the page to be filled
  // from the oldest rows of the push, with nothing in between.
  let headStart = sorted.length;
  let shown = 0;
  for (let i = sorted.length - 1; i >= 0 && shown < plan.pageSize; i--) {
    headStart = i;
    if (sorted[i].type !== MessageType.PluginUpdate) shown++;
  }
  const more = sorted
    .slice(0, headStart)
    .some((row) => row.type !== MessageType.PluginUpdate);
  if (!more) headStart = sorted.length;
  return [
    ...chunk(sorted.slice(headStart).reverse(), "head", plan),
    ...chunk(sorted.slice(0, headStart), "asc", plan),
  ];
}

function chunk<T>(rows: T[], order: PushOrder, plan: PushPlan<T>): PushBatch<T>[] {
  const out: PushBatch<T>[] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const row of rows) {
    const size = plan.sizeOf(row);
    if (cur.length && (cur.length >= plan.batchSize || bytes + size > plan.maxBatchBytes)) {
      out.push({ rows: cur, order });
      cur = [];
      bytes = 0;
    }
    cur.push(row);
    bytes += size;
  }
  if (cur.length) out.push({ rows: cur, order });
  return out;
}

export interface PushPace {
  /** Frames sent back to back before the pace starts. */
  burst: number;
  /** Gap between frames after that. */
  paceMs: number;
  /** Waits before each retry of a refused frame. */
  retryMs: readonly number[];
}

/**
 * Fast enough for a phone-class receiver on an older build, which verifies
 * each batch (about 70-115 ms for 20 rows) before it reads the next frame off
 * the channel, and closes the channel once 32 frames wait unread. 10,000
 * rows take under a minute; the head is in the burst.
 */
export const PUSH_PACE: PushPace = { burst: 4, paceMs: 100, retryMs: [250, 1_000] };

/**
 * Send frames 0..count-1 in order, each once the one before was accepted.
 * True when every frame was; false as soon as one is refused for good or the
 * push should stop (`alive` turned false), with nothing sent after it.
 */
export async function runPush(
  count: number,
  send: (index: number) => Promise<boolean>,
  opts: {
    alive?: () => boolean;
    sleep?: (ms: number) => Promise<void>;
    pace?: PushPace;
  } = {}
): Promise<boolean> {
  const pace = opts.pace ?? PUSH_PACE;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const alive = opts.alive ?? (() => true);
  for (let i = 0; i < count; i++) {
    if (i >= pace.burst) await sleep(pace.paceMs);
    if (!alive()) return false;
    let ok = await send(i).catch(() => false);
    for (const wait of pace.retryMs) {
      if (ok) break;
      // A refusal is usually the channel's in-flight window, full of other
      // traffic for a moment, or a channel that closed and reopens on the
      // next send. Anything longer ends the push; the receiver asks again.
      await sleep(wait);
      if (!alive()) return false;
      ok = await send(i).catch(() => false);
    }
    if (!ok) return false;
  }
  return true;
}
