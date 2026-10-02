import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageType } from "$lib/types/message";
import { InboundPushes, type BatchOutcome } from "./sync-inbound";
import { planPush } from "./sync-push";

const ROOM = "rd2_room";
const STALL = 1_000;
const EXPECT = 500;

type Row = { id: string; lamport: number; type: string; senderId: string };

/** A room's history: `n` rows, lamport 1..n, from senders taking turns. */
function history(n: number, senders = ["did:a", "did:b", "did:c"]): Row[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `m${String(i + 1).padStart(6, "0")}`,
    lamport: i + 1,
    type: MessageType.Text,
    senderId: senders[i % senders.length],
  }));
}

function harness() {
  const committed = new Map<string, number>();
  const held = new Set<string>();
  const released: string[] = [];
  const tracker = new InboundPushes(
    {
      commit: async (room, senderId, lamport) => {
        const key = `${room}|${senderId}`;
        if ((committed.get(key) ?? -1) < lamport) committed.set(key, lamport);
      },
      hold: (room) => { held.add(room); },
      release: async (room) => { held.delete(room); released.push(room); },
    },
    { stallMs: STALL, expectMs: EXPECT }
  );
  /** The receiver's committed watermark for a sender, as its digest says it. */
  const mark = (senderId: string) => committed.get(`${ROOM}|${senderId}`) ?? -1;
  return { tracker, committed, held, released, mark };
}

const outcome = (rows: Row[], floors: Map<string, number> = new Map()): BatchOutcome => ({
  held: rows.map((r) => ({ senderId: r.senderId, lamport: r.lamport })),
  floors,
});

/** A current build's push of `rows`, as frames. */
function pacedFrames(rows: Row[]) {
  const batches = planPush(rows, {
    batchSize: 20, pageSize: 50, maxBatchBytes: 1_500_000, sizeOf: () => 512,
  });
  return batches.map((b, i) => ({
    frame: { batchIndex: i, totalBatches: batches.length, order: b.order },
    rows: b.rows,
  }));
}

/** An older build's push: newest first, unmarked. */
function oldFrames(rows: Row[]) {
  const sorted = [...rows].sort((a, b) => b.lamport - a.lamport);
  const out: { frame: { batchIndex: number; totalBatches: number }; rows: Row[] }[] = [];
  for (let i = 0; i < sorted.length; i += 20) out.push({ frame: { batchIndex: 0, totalBatches: 0 }, rows: sorted.slice(i, i + 20) });
  out.forEach((f, i) => { f.frame = { batchIndex: i, totalBatches: out.length }; });
  return out;
}

/** Everything above the receiver's committed watermarks: what the next push carries. */
function stillOffered(rows: Row[], mark: (s: string) => number): Row[] {
  return rows.filter((r) => r.lamport > mark(r.senderId));
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("a paced push", () => {
  it("claims the oldest-first part batch by batch and the head only at the end", async () => {
    const { tracker, mark } = harness();
    const rows = history(200);
    const frames = pacedFrames(rows);
    expect(frames.filter((f) => f.frame.order === "head").length).toBeGreaterThan(0);
    for (const f of frames.slice(0, -1)) {
      await tracker.batch("peer1", ROOM, f.frame, async () => outcome(f.rows));
    }
    // All but the last "asc" batch: everything up to there is claimed, and
    // the newest page waits for the push to be whole.
    expect(Math.max(mark("did:a"), mark("did:b"), mark("did:c"))).toBe(140);
    const last = frames.at(-1)!;
    await tracker.batch("peer1", ROOM, last.frame, async () => outcome(last.rows));
    await tracker.complete("peer1", ROOM);
    expect(Math.max(mark("did:a"), mark("did:b"), mark("did:c"))).toBe(200);
    expect(stillOffered(rows, mark)).toEqual([]);
  });

  it("completes a push whose SyncComplete arrives before its first batch", async () => {
    // Not what the transport hands it any more - a DM's frames now wait in
    // line - but a push must not depend on the order of its SyncComplete.
    const { tracker, mark, held } = harness();
    const rows = history(10);
    const [only] = pacedFrames(rows);
    await tracker.complete("peer1", ROOM);
    await tracker.batch("peer1", ROOM, only.frame, async () => outcome(only.rows));
    await tracker.complete("peer1", ROOM);
    expect(stillOffered(rows, mark)).toEqual([]);
    expect(held.has(ROOM)).toBe(false);
  });

  it("leaves no hole when it stops short: the next push offers exactly what is missing", async () => {
    const { tracker, mark, held, released } = harness();
    const rows = history(500);
    const frames = pacedFrames(rows);
    // The connection drops after the head and four batches of the rest.
    const headCount = frames.filter((f) => f.frame.order === "head").length;
    for (const f of frames.slice(0, headCount + 4)) {
      await tracker.batch("peer1", ROOM, f.frame, async () => outcome(f.rows));
    }
    await vi.advanceTimersByTimeAsync(STALL + 1);
    // Claimed: a contiguous prefix, rows 1..80. Nothing above it.
    const offered = stillOffered(rows, mark);
    expect(offered.map((r) => r.lamport)).toEqual(
      Array.from({ length: 420 }, (_, i) => i + 81)
    );
    // Still held: a live message must not claim over the gap.
    expect(held.has(ROOM)).toBe(true);
    expect(released).toEqual([]);
    // The next push completes and the room is whole.
    for (const f of pacedFrames(offered)) {
      await tracker.batch("peer2", ROOM, f.frame, async () => outcome(f.rows));
    }
    await tracker.complete("peer2", ROOM);
    expect(stillOffered(rows, mark)).toEqual([]);
    expect(held.has(ROOM)).toBe(false);
    expect(released).toEqual([ROOM]);
  });

  it("stops claiming at a missing batch", async () => {
    const { tracker, mark } = harness();
    const frames = pacedFrames(history(30)); // no head: two "asc" batches
    expect(frames.map((f) => f.frame.order)).toEqual(["asc", "asc"]);
    const third = { batchIndex: 2, totalBatches: 3, order: "asc" };
    await tracker.batch("peer1", ROOM, { ...frames[0].frame, totalBatches: 3 }, async () => outcome(frames[0].rows));
    // Batch 1 never arrives; batch 2 does.
    await tracker.batch("peer1", ROOM, third, async () => outcome(history(60).slice(40)));
    await tracker.complete("peer1", ROOM);
    expect(Math.max(mark("did:a"), mark("did:b"), mark("did:c"))).toBe(20);
  });

  it("never claims past a row that failed verification", async () => {
    const { tracker, mark } = harness();
    const rows = history(40, ["did:a"]);
    const frames = pacedFrames(rows);
    await tracker.batch("peer1", ROOM, frames[0].frame, async () =>
      outcome(frames[0].rows.filter((r) => r.lamport !== 12), new Map([["did:a", 12]])));
    await tracker.batch("peer1", ROOM, frames[1].frame, async () => outcome(frames[1].rows));
    await tracker.complete("peer1", ROOM);
    expect(mark("did:a")).toBe(11);
  });

  it("completes when its SyncComplete overtakes the last batch", async () => {
    const { tracker, mark } = harness();
    const rows = history(30);
    const frames = pacedFrames(rows);
    await tracker.batch("peer1", ROOM, frames[0].frame, async () => outcome(frames[0].rows));
    const done = tracker.complete("peer1", ROOM);
    await tracker.batch("peer1", ROOM, frames[1].frame, async () => outcome(frames[1].rows));
    await done;
    expect(stillOffered(rows, mark)).toEqual([]);
  });
});

describe("an older build's push", () => {
  it("claims nothing until every batch it announced is in, then everything", async () => {
    const { tracker, mark } = harness();
    const rows = history(100);
    const frames = oldFrames(rows);
    for (const f of frames.slice(0, -1)) {
      await tracker.batch("old", ROOM, f.frame, async () => outcome(f.rows));
    }
    expect(mark("did:a")).toBe(-1);
    const last = frames.at(-1)!;
    await tracker.batch("old", ROOM, last.frame, async () => outcome(last.rows));
    await tracker.complete("old", ROOM);
    expect(stillOffered(rows, mark)).toEqual([]);
  });

  it("never turns the newest rows of a cut-off push into a permanent hole", async () => {
    const { tracker, mark } = harness();
    const rows = history(5_000);
    // What the old pusher's channel let through: 32 batches, newest first,
    // and no SyncComplete.
    const frames = oldFrames(rows).slice(0, 32);
    for (const f of frames) await tracker.batch("old", ROOM, f.frame, async () => outcome(f.rows));
    await vi.advanceTimersByTimeAsync(STALL + 1);
    // Nothing claimed: every row is still offered by any other peer.
    expect(stillOffered(rows, mark)).toHaveLength(5_000);
    // That peer alone is told what it already gave, so it stops re-sending
    // the same newest rows on every digest.
    const toOld = tracker.withClaims("old", ROOM, {});
    expect(Math.max(...Object.values(toOld))).toBe(5_000);
    expect(Math.min(...Object.values(toOld))).toBe(5_000 - 2);
    expect(tracker.withClaims("other", ROOM, {})).toEqual({});
  });

  it("proves nothing with a push answering those claims", async () => {
    const { tracker, mark, held } = harness();
    const rows = history(100);
    for (const f of oldFrames(rows).slice(0, 2)) {
      await tracker.batch("old", ROOM, f.frame, async () => outcome(f.rows));
    }
    await vi.advanceTimersByTimeAsync(STALL + 1);
    // Its next push starts above the claims, so completing it shows nothing
    // about the rows below them.
    const newer = history(110).slice(100);
    for (const f of oldFrames(newer)) {
      await tracker.batch("old", ROOM, f.frame, async () => outcome(f.rows));
    }
    await tracker.complete("old", ROOM);
    expect(mark("did:a")).toBe(-1);
    expect(held.has(ROOM)).toBe(true);
    expect(Math.max(...Object.values(tracker.withClaims("old", ROOM, {})))).toBe(110);
  });

  it("drops its claims once the peer pushes like a current build", async () => {
    const { tracker } = harness();
    for (const f of oldFrames(history(100)).slice(0, 2)) {
      await tracker.batch("old", ROOM, f.frame, async () => outcome(f.rows));
    }
    await vi.advanceTimersByTimeAsync(STALL + 1);
    expect(Object.keys(tracker.withClaims("old", ROOM, {})).length).toBeGreaterThan(0);
    const f = pacedFrames(history(5))[0];
    await tracker.batch("old", ROOM, f.frame, async () => outcome(f.rows));
    expect(tracker.withClaims("old", ROOM, {})).toEqual({});
  });
});

describe("holding a room", () => {
  it("holds while a digest may still bring a push, then lets go", async () => {
    const { tracker, held, released } = harness();
    tracker.expect("peer1", ROOM);
    expect(held.has(ROOM)).toBe(true);
    await vi.advanceTimersByTimeAsync(EXPECT + 1);
    expect(held.has(ROOM)).toBe(false);
    expect(released).toEqual([ROOM]);
  });

  it("lets go as soon as the peer it asked says no push is coming", async () => {
    const { tracker, held, released } = harness();
    const nonce = tracker.expect("peer1", ROOM);
    tracker.answered("peer1", ROOM, nonce);
    await vi.advanceTimersByTimeAsync(0);
    expect(held.has(ROOM)).toBe(false);
    expect(released).toEqual([ROOM]);
  });

  // A repair digest, then a gap's digest to the same peer before it answered
  // the first: the answer to the first must not end the wait the gap's set,
  // or the gap message claims before the push it asked for begins.
  it("ends a wait only on the answer to the latest digest sent that peer", async () => {
    const { tracker, held } = harness();
    const first = tracker.expect("peer1", ROOM);
    const second = tracker.expect("peer1", ROOM);
    expect(second).not.toBe(first);
    tracker.answered("peer1", ROOM, first);
    await vi.advanceTimersByTimeAsync(0);
    expect(held.has(ROOM)).toBe(true);
    tracker.answered("peer1", ROOM, second);
    await vi.advanceTimersByTimeAsync(0);
    expect(held.has(ROOM)).toBe(false);
  });

  it("holds until every peer it asked has answered, and only that peer's answer counts", async () => {
    const { tracker, held } = harness();
    const nonce = tracker.expect("peer1", ROOM);
    tracker.expect("old", ROOM);
    tracker.answered("peer1", ROOM, nonce);
    // An answer from somebody we did not ask ends nothing.
    tracker.answered("stranger", ROOM, nonce);
    await vi.advanceTimersByTimeAsync(EXPECT / 2);
    expect(held.has(ROOM)).toBe(true);
    // An older build never answers: its wait runs out on its own.
    await vi.advanceTimersByTimeAsync(EXPECT);
    expect(held.has(ROOM)).toBe(false);
  });

  it("passes the hold from a digest to the push that answers it", async () => {
    const { tracker, held } = harness();
    tracker.expect("peer1", ROOM);
    const frames = pacedFrames(history(30));
    await tracker.batch("peer1", ROOM, frames[0].frame, async () => outcome(frames[0].rows));
    // Long past the digest's wait, the push is still open: still held.
    await vi.advanceTimersByTimeAsync(EXPECT + 1);
    expect(held.has(ROOM)).toBe(true);
    await tracker.batch("peer1", ROOM, frames[1].frame, async () => outcome(frames[1].rows));
    await tracker.complete("peer1", ROOM);
    expect(held.has(ROOM)).toBe(false);
  });

  it("holds from a push's first frame until it completes", async () => {
    const { tracker, held } = harness();
    const f = pacedFrames(history(5))[0];
    await tracker.batch("peer1", ROOM, f.frame, async () => outcome(f.rows));
    expect(held.has(ROOM)).toBe(true);
    await tracker.complete("peer1", ROOM);
    expect(held.has(ROOM)).toBe(false);
  });

  it("keeps holding after a push stops short, until one completes", async () => {
    const { tracker, held } = harness();
    const frames = pacedFrames(history(30));
    await tracker.batch("peer1", ROOM, frames[0].frame, async () => outcome(frames[0].rows));
    await vi.advanceTimersByTimeAsync(STALL + EXPECT + 1);
    expect(held.has(ROOM)).toBe(true);
    for (const f of frames) await tracker.batch("peer2", ROOM, f.frame, async () => outcome(f.rows));
    await tracker.complete("peer2", ROOM);
    expect(held.has(ROOM)).toBe(false);
  });

  it("treats a refused frame as a gap", async () => {
    const { tracker, mark, held } = harness();
    const frames = pacedFrames(history(30));
    await tracker.batch("peer1", ROOM, frames[0].frame, async () => null);
    await tracker.batch("peer1", ROOM, frames[1].frame, async () => outcome(frames[1].rows));
    await tracker.complete("peer1", ROOM);
    expect(mark("did:a")).toBe(-1);
    expect(held.has(ROOM)).toBe(true);
  });
});
