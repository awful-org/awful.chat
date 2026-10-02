// The receiving end of a history push, lifted out of transport.svelte.ts so
// it can be tested: that module builds a libp2p node at import time.
//
// A watermark says "I hold everything this sender wrote up to here", and it
// never moves back: nobody offers what is below it again. Claiming one per
// row as it landed assumed a push always arrives whole. It does not: it stops
// when the channel or the peer does, and older builds lost every batch past
// the room channel's 32-frame window. Pushed newest first, the first batch
// alone claimed every recent sender's newest row, and whatever had not
// arrived below it was gone for good.
//
// So the rows of a push claim only what cannot skip anything:
//  - "asc" batches (oldest first, from builds that pace their pushes) claim
//    as each one is stored, as long as every earlier batch of the push was;
//  - "head" batches, and every batch of an older build's push, claim once
//    the push completes: every batch it announced arrived, in order. That
//    alone tells a whole push from a cut-off one (an older build's lost
//    batches never arrive), so it does not wait on SyncComplete either;
//  - meanwhile every other advance in the room, live messages included,
//    waits in storage (holdWatermarks) and is written once a push into the
//    room completes. A digest we send holds the room the same way until the
//    peer answers it: its push's first frame, or a SyncNone saying none is
//    coming - or, from an older build, which never says so, until the wait
//    runs out. Holding for that whole wait after every digest kept a busy
//    room held nearly all the time, and every exchange in it read as us
//    being behind on messages we already had.
// An older build whose push stopped short would re-send the same newest rows
// on every digest, for good. What it did deliver is remembered for that peer
// alone (withClaims) and advertised only to it; any other peer is still
// asked for everything, so a current build fills the gap.
import { SYNC_STALL_MS } from "./sync-progress.svelte";
import type { PushOrder } from "./sync-push";

export interface HeldRow {
  senderId: string;
  lamport: number;
}

export interface BatchOutcome {
  /** Rows of the batch we now hold: stored now, or held already. */
  held: HeldRow[];
  /** Per sender, the lowest signed row that failed verification: never claimed past. */
  floors: ReadonlyMap<string, number>;
}

/** The parts of a SyncBatch frame that place it in its push. Peer-chosen. */
export interface PushFrame {
  batchIndex: unknown;
  totalBatches: unknown;
  order?: unknown;
}

export interface InboundDeps {
  /** Write a watermark now, past any hold: the push proved the claim. */
  commit(room: string, senderId: string, lamport: number): Promise<void>;
  /** Make other advances in the room wait. Idempotent. */
  hold(room: string): void;
  /** Write what waited, and stop waiting. */
  release(room: string): Promise<void>;
}

/** A push with no frame for this long has stopped. Same clock as the pill. */
export const PUSH_STALL_MS = SYNC_STALL_MS;
/**
 * How long a digest keeps the room held when the peer never answers it: an
 * older build sends no SyncNone, and a push takes a while to start - the
 * pusher reads and decrypts what we lack before its first frame. Past it
 * with no push, there was nothing to send.
 */
export const EXPECT_PUSH_MS = 15_000;
/** Peer+room claim sets kept, and senders per set. */
const MAX_CLAIMED = 256;
const MAX_CLAIM_SENDERS = 4096;

interface Push {
  key: string;
  room: string;
  /** Order of its first batch; undefined for an older build's push. */
  first: PushOrder | undefined;
  /** Order of its latest batch. */
  phase: PushOrder | undefined;
  next: number;
  total: number;
  /** A gap, a refused frame or a failure: nothing more is claimed from it. */
  broken: boolean;
  /** Worked out against claims we advertised to this peer: it cannot prove a whole history. */
  partial: boolean;
  /** Rows held but not claimable until the push completes. */
  pending: Map<string, number[]>;
  floors: Map<string, number>;
  /** Its frames are handled one at a time, in arrival order. */
  chain: Promise<void>;
  timer: ReturnType<typeof setTimeout> | null;
  ended: boolean;
  /** Settles when the push is over, however it ended. */
  done: Promise<void>;
  settleDone: () => void;
}

interface RoomState {
  open: Set<Push>;
  /** A push stopped short and none has completed since. */
  owed: boolean;
  /** Peers we asked for history that have not answered yet: by peer, its wait. */
  expecting: Map<string, ReturnType<typeof setTimeout>>;
}

function validRow(row: HeldRow): boolean {
  return typeof row.senderId === "string" && !!row.senderId &&
    Number.isSafeInteger(row.lamport) && row.lamport >= 0;
}

/** Highest lamport per sender, below that sender's floor. */
function claimable(
  rows: Iterable<readonly [string, number]>,
  floors: ReadonlyMap<string, number>
): Map<string, number> {
  const best = new Map<string, number>();
  for (const [senderId, lamport] of rows) {
    const floor = floors.get(senderId);
    if (floor !== undefined && lamport >= floor) continue;
    if ((best.get(senderId) ?? -1) < lamport) best.set(senderId, lamport);
  }
  return best;
}

function* entries(pending: Map<string, number[]>): Iterable<readonly [string, number]> {
  for (const [senderId, lamports] of pending) {
    for (const lamport of lamports) yield [senderId, lamport] as const;
  }
}

export class InboundPushes {
  private pushes = new Map<string, Push>();
  /** Pushes with every batch in, still being handled: settled with them. */
  private finishing = new Map<string, Promise<void>>();
  private rooms = new Map<string, RoomState>();
  private claims = new Map<string, Map<string, number>>();

  constructor(
    private readonly deps: InboundDeps,
    private readonly opts: { stallMs: number; expectMs: number } = {
      stallMs: PUSH_STALL_MS,
      expectMs: EXPECT_PUSH_MS,
    }
  ) {}

  /**
   * We just asked `peer` for this room's history: a push may be on its way.
   * The room is held until that peer answers - its push's first frame, its
   * SyncComplete, or a SyncNone - or the wait runs out.
   */
  expect(peer: string, room: string): void {
    const state = this.room(room);
    const before = state.expecting.get(peer);
    if (before) clearTimeout(before);
    const timer = setTimeout(() => {
      if (state.expecting.get(peer) !== timer) return;
      state.expecting.delete(peer);
      void this.settle(room).catch(() => {});
    }, this.opts.expectMs);
    state.expecting.set(peer, timer);
  }

  /**
   * `peer` answered what we asked it for this room: a push from it is open
   * (and holds the room itself), or none is coming.
   */
  answered(peer: string, room: string): void {
    const state = this.rooms.get(room);
    const timer = state?.expecting.get(peer);
    if (!state || timer === undefined) return;
    clearTimeout(timer);
    state.expecting.delete(peer);
    void this.settle(room).catch(() => {});
  }

  /**
   * One SyncBatch frame of a push. `process` stores its rows and says what we
   * now hold, or null when the frame was refused whole. Frames of one push
   * run one at a time, in arrival order; the promise settles with this one.
   */
  batch(
    peer: string,
    room: string,
    frame: PushFrame,
    process: () => Promise<BatchOutcome | null>
  ): Promise<void> {
    const key = `${peer}|${room}`;
    const order = frame.order === "head" || frame.order === "asc" ? frame.order : undefined;
    const index = frame.batchIndex;
    const total = frame.totalBatches;
    const valid =
      typeof index === "number" && typeof total === "number" &&
      Number.isSafeInteger(index) && Number.isSafeInteger(total) &&
      index >= 0 && total >= 1 && index < total;
    let push = this.pushes.get(key);
    if (!push || (valid && index === 0)) {
      push = this.start(key, room, order, valid ? total : 0, push);
      // Joined part-way: whatever came before this frame is unknown.
      if (!(valid && index === 0)) push.broken = true;
    }
    const p = push;
    if (!valid || index !== p.next || total !== p.total || !this.fits(p, order)) {
      p.broken = true;
    }
    if (valid) p.next = index + 1;
    p.phase = order;
    this.arm(p);
    // Its push is open from here, and holds the room until it ends.
    this.answered(peer, room);
    const run = p.chain.then(async () => {
      let outcome: BatchOutcome | null = null;
      try {
        outcome = await process();
      } catch {
        outcome = null;
      }
      if (!outcome) {
        p.broken = true;
        return;
      }
      await this.account(p, order, outcome);
    });
    p.chain = run.catch(() => {});
    // Every batch it announced is in: the push is whole (or, broken, over).
    if (p.total > 0 && p.next >= p.total) this.finish(p);
    return run;
  }

  /**
   * The pusher's SyncComplete for the room. Settles once the push is over and
   * its batches are handled. A push still missing a batch keeps waiting for
   * it until the stall; one already broken ends now.
   */
  complete(peer: string, room: string): Promise<void> {
    const key = `${peer}|${room}`;
    const p = this.pushes.get(key);
    let done: Promise<void>;
    if (!p) {
      done = this.finishing.get(key) ?? Promise.resolve();
    } else {
      if (p.broken) this.finish(p);
      else this.arm(p);
      done = p.done;
    }
    // Whatever we asked it, the peer is done answering.
    this.answered(peer, room);
    return done;
  }

  /** What we advertise to `peer` for `room`: `watermarks` plus its claims. */
  withClaims(
    peer: string,
    room: string,
    watermarks: Record<string, number>
  ): Record<string, number> {
    const claims = this.claims.get(`${peer}|${room}`);
    if (!claims) return watermarks;
    for (const [senderId, lamport] of claims) {
      if ((watermarks[senderId] ?? -1) < lamport) watermarks[senderId] = lamport;
    }
    return watermarks;
  }

  /** Is anything about this room still waiting on a push? */
  holding(room: string): boolean {
    return this.rooms.has(room);
  }

  /** Forget everything: the session that received these pushes is over. */
  reset(): void {
    for (const p of this.pushes.values()) {
      if (p.timer) clearTimeout(p.timer);
      p.ended = true;
      p.settleDone();
    }
    for (const state of this.rooms.values()) {
      for (const timer of state.expecting.values()) clearTimeout(timer);
    }
    this.pushes.clear();
    this.finishing.clear();
    this.rooms.clear();
    this.claims.clear();
  }

  private room(room: string): RoomState {
    let state = this.rooms.get(room);
    if (!state) {
      state = { open: new Set(), owed: false, expecting: new Map() };
      this.rooms.set(room, state);
    }
    this.deps.hold(room);
    return state;
  }

  private start(
    key: string,
    room: string,
    order: PushOrder | undefined,
    total: number,
    before: Push | undefined
  ): Push {
    // The peer started over: the push it left is over too, short.
    if (before) {
      this.pushes.delete(key);
      before.chain = before.chain.then(() => this.end(before, false)).catch(() => {});
    }
    const claims = this.claims.get(key);
    let settleDone!: () => void;
    const done = new Promise<void>((resolve) => (settleDone = resolve));
    const p: Push = {
      key,
      room,
      first: order,
      phase: order,
      next: 0,
      total,
      broken: false,
      partial: !!claims,
      pending: new Map(),
      floors: new Map(),
      chain: before ? before.chain : Promise.resolve(),
      timer: null,
      ended: false,
      done,
      settleDone,
    };
    // A paced push means a current build, which needs no claims: our next
    // digest to it goes out without them. This push still answered them.
    if (order !== undefined && claims) this.claims.delete(key);
    this.pushes.set(key, p);
    this.room(room).open.add(p);
    return p;
  }

  /** Head batches lead, "asc" follows; an older build marks none. */
  private fits(p: Push, order: PushOrder | undefined): boolean {
    if (p.first === undefined) return order === undefined;
    if (order === undefined) return false;
    return p.phase === "head" || order === "asc";
  }

  private async account(p: Push, order: PushOrder | undefined, outcome: BatchOutcome): Promise<void> {
    for (const [senderId, lamport] of outcome.floors) {
      const at = p.floors.get(senderId);
      if (at === undefined || lamport < at) p.floors.set(senderId, lamport);
    }
    const rows = outcome.held.filter(validRow);
    if (order === "asc") {
      if (p.broken || p.partial) return;
      // Oldest first, and every earlier batch stored: each sender's rows up
      // to its highest one here have all arrived.
      try {
        const pairs = rows.map((r) => [r.senderId, r.lamport] as const);
        for (const [senderId, lamport] of claimable(pairs, p.floors)) {
          await this.deps.commit(p.room, senderId, lamport);
        }
      } catch {
        p.broken = true;
      }
      return;
    }
    for (const row of rows) {
      const list = p.pending.get(row.senderId);
      if (list) list.push(row.lamport);
      else p.pending.set(row.senderId, [row.lamport]);
    }
  }

  private arm(p: Push): void {
    if (p.timer) clearTimeout(p.timer);
    p.timer = setTimeout(() => {
      p.timer = null;
      if (this.pushes.get(p.key) === p) this.pushes.delete(p.key);
      p.chain = p.chain.then(() => this.end(p, false)).catch(() => {});
    }, this.opts.stallMs);
  }

  /** Complete the push, behind the batches still queued for it. */
  private finish(p: Push): void {
    if (this.pushes.get(p.key) !== p) return;
    if (p.timer) clearTimeout(p.timer);
    p.timer = null;
    // Over from here, whatever its queued batches still do: a later frame
    // starts another push.
    this.pushes.delete(p.key);
    this.finishing.set(p.key, p.done);
    void p.done.then(() => {
      if (this.finishing.get(p.key) === p.done) this.finishing.delete(p.key);
    });
    p.chain = p.chain
      .then(async () => {
        let claimed = !p.broken && !p.partial && p.total > 0 && p.next === p.total;
        if (claimed) {
          try {
            for (const [senderId, lamport] of claimable(entries(p.pending), p.floors)) {
              await this.deps.commit(p.room, senderId, lamport);
            }
          } catch {
            claimed = false;
          }
        }
        await this.end(p, claimed);
      })
      .catch(() => {});
  }

  private async end(p: Push, completed: boolean): Promise<void> {
    if (p.ended) return;
    p.ended = true;
    try {
      if (p.timer) clearTimeout(p.timer);
      p.timer = null;
      if (this.pushes.get(p.key) === p) this.pushes.delete(p.key);
      if (p.first === undefined && !completed) this.claim(p);
      const state = this.rooms.get(p.room);
      if (!state) return;
      state.open.delete(p);
      state.owed = !completed;
      await this.settle(p.room);
    } finally {
      p.settleDone();
    }
  }

  /** Remember for this peer alone what its short push delivered. */
  private claim(p: Push): void {
    const best = claimable(entries(p.pending), p.floors);
    if (!best.size) return;
    let claims = this.claims.get(p.key);
    if (!claims) {
      if (this.claims.size >= MAX_CLAIMED) {
        this.claims.delete(this.claims.keys().next().value as string);
      }
      claims = new Map();
      this.claims.set(p.key, claims);
    }
    for (const [senderId, lamport] of best) {
      const at = claims.get(senderId);
      if (at === undefined && claims.size >= MAX_CLAIM_SENDERS) continue;
      if (at === undefined || at < lamport) claims.set(senderId, lamport);
    }
  }

  private async settle(room: string): Promise<void> {
    const state = this.rooms.get(room);
    if (!state || state.open.size || state.owed || state.expecting.size) return;
    this.rooms.delete(room);
    await this.deps.release(room);
  }
}
