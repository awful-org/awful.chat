import { afterEach, describe, expect, it, vi } from "vitest";
import { SecureRoomChannel } from "$lib/room-security/channel";
import { deriveRoomKeys, newRoomSecret } from "$lib/room-security/keys";
import { MessageType } from "$lib/types/message";
import { PUSH_PACE, planPush, runPush, type PushPace } from "./sync-push";

type Row = { id: string; lamport: number; type: string; size?: number };

const row = (lamport: number, type: string = MessageType.Text): Row => ({
  id: `m${String(lamport).padStart(6, "0")}`,
  lamport,
  type,
});

const plan = {
  batchSize: 20,
  pageSize: 50,
  maxBatchBytes: 1_500_000,
  sizeOf: (r: Row) => r.size ?? 512,
};

const noWait: PushPace = { burst: 4, paceMs: 0, retryMs: [0, 0] };

describe("planPush", () => {
  it("sends the newest page first, then everything older oldest first", () => {
    const rows = Array.from({ length: 200 }, (_, i) => row(i + 1));
    const batches = planPush([...rows].reverse(), plan);
    const head = batches.filter((b) => b.order === "head");
    const asc = batches.filter((b) => b.order === "asc");
    // The head leads, and covers exactly the newest page.
    expect(batches.slice(0, head.length).every((b) => b.order === "head")).toBe(true);
    expect(head.flatMap((b) => b.rows).map((r) => r.lamport))
      .toEqual(Array.from({ length: 50 }, (_, i) => 200 - i));
    // Then the rest, oldest first, with no row missing or repeated.
    expect(asc.flatMap((b) => b.rows).map((r) => r.lamport))
      .toEqual(Array.from({ length: 150 }, (_, i) => i + 1));
    expect(batches.every((b) => b.rows.length <= 20)).toBe(true);
  });

  it("sends a push that fits on one screen oldest first, with no head", () => {
    const batches = planPush([row(3), row(1), row(2)], plan);
    expect(batches).toEqual([{ order: "asc", rows: [row(1), row(2), row(3)] }]);
  });

  it("stretches the head over plugin updates the page would skip", () => {
    // The 50 newest rows the page shows, with an update between each pair.
    const rows: Row[] = [];
    let lamport = 0;
    for (let i = 0; i < 10; i++) rows.push(row(++lamport));
    for (let i = 0; i < 50; i++) {
      rows.push(row(++lamport));
      rows.push(row(++lamport, MessageType.PluginUpdate));
    }
    const head = planPush(rows, plan).filter((b) => b.order === "head").flatMap((b) => b.rows);
    expect(head.filter((r) => r.type !== MessageType.PluginUpdate)).toHaveLength(50);
    expect(Math.min(...head.map((r) => r.lamport))).toBe(11);
  });

  it("closes a batch early on bytes", () => {
    const rows = Array.from({ length: 10 }, (_, i) => ({ ...row(i + 1), size: 600_000 }));
    const batches = planPush(rows, plan);
    expect(batches.every((b) => b.rows.reduce((n, r) => n + r.size!, 0) <= 1_500_000)).toBe(true);
    expect(batches.flatMap((b) => b.rows)).toHaveLength(10);
  });
});

describe("runPush", () => {
  it("sends each frame only once the one before was accepted", async () => {
    let inFlight = 0;
    let most = 0;
    const sent: number[] = [];
    const ok = await runPush(10, async (i) => {
      inFlight++;
      most = Math.max(most, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      sent.push(i);
      inFlight--;
      return true;
    }, { pace: noWait });
    expect(ok).toBe(true);
    expect(sent).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(most).toBe(1);
  });

  it("retries a refused frame and carries on when it is taken", async () => {
    const tries: number[] = [];
    const ok = await runPush(3, async (i) => {
      tries.push(i);
      return !(i === 1 && tries.filter((t) => t === 1).length < 2);
    }, { pace: noWait });
    expect(ok).toBe(true);
    expect(tries).toEqual([0, 1, 1, 2]);
  });

  it("stops at a frame refused for good and sends nothing after it", async () => {
    const tries: number[] = [];
    const ok = await runPush(5, async (i) => {
      tries.push(i);
      return i !== 2;
    }, { pace: noWait });
    expect(ok).toBe(false);
    expect(tries).toEqual([0, 1, 2, 2, 2]);
  });

  it("stops when the push should no longer run", async () => {
    let alive = true;
    const sent: number[] = [];
    const ok = await runPush(5, async (i) => {
      sent.push(i);
      if (i === 1) alive = false;
      return true;
    }, { pace: noWait, alive: () => alive });
    expect(ok).toBe(false);
    expect(sent).toEqual([0, 1]);
  });

  it("paces frames after the burst", async () => {
    const waits: number[] = [];
    await runPush(7, async () => true, {
      sleep: async (ms) => { waits.push(ms); },
    });
    expect(waits).toEqual(Array(7 - PUSH_PACE.burst).fill(PUSH_PACE.paceMs));
  });

  it("never fills an older phone's channel queue, however long the push", async () => {
    // An older receiver handles a frame - 20 verifies, about 113 ms on a
    // phone-class CPU (6x throttle) - before it reads the next one, and
    // closes the channel once 32 frames wait.
    const HANDLE_MS = 113;
    let now = 0;
    let busyUntil = 0;
    const finishes: number[] = [];
    let most = 0;
    await runPush(500, async () => {
      busyUntil = Math.max(now, busyUntil) + HANDLE_MS;
      finishes.push(busyUntil);
      most = Math.max(most, finishes.filter((t) => t > now).length);
      return true;
    }, { sleep: async (ms) => { now += ms; } });
    expect(most).toBeLessThan(32);
  });
});

// The room channel itself refuses past 32 frames in flight. This is the
// hole the finding measured, reproduced on the real channel.
describe("a push over a real room channel", () => {
  const channels: SecureRoomChannel[] = [];
  afterEach(() => {
    for (const c of channels) c.close();
    channels.length = 0;
  });

  async function pair() {
    const keys = deriveRoomKeys(newRoomSecret());
    const delivered: Uint8Array[] = [];
    let a: SecureRoomChannel;
    const b = new SecureRoomChannel(keys, "bob", "alice", "responder", async (f) => {
      queueMicrotask(() => a.receive(f, JSON.stringify(f).length));
    }, (data) => delivered.push(data), () => {});
    a = new SecureRoomChannel(keys, "alice", "bob", "initiator", async (f) => {
      queueMicrotask(() => b.receive(f, JSON.stringify(f).length));
    }, () => {}, () => {});
    channels.push(a, b);
    await Promise.all([a.ready, b.ready]);
    return { a, b, delivered };
  }

  const frame = (i: number) => new TextEncoder().encode(JSON.stringify({ i }));
  const indexes = (delivered: Uint8Array[]) =>
    delivered.map((d) => (JSON.parse(new TextDecoder().decode(d)) as { i: number }).i);

  it("loses every frame past the window when they are all fired at once", async () => {
    const { a, delivered } = await pair();
    // The old push: every batch sent at once, the answers never read.
    const answers = await Promise.all(Array.from({ length: 60 }, (_, i) => a.send(frame(i))));
    await vi.waitFor(() => expect(delivered.length).toBe(32));
    expect(answers.filter(Boolean)).toHaveLength(32);
    // The last frame - where SyncComplete went - never arrives.
    expect(indexes(delivered)).not.toContain(59);
  });

  it("delivers every frame, in order, when each waits for the one before", async () => {
    const { a, delivered } = await pair();
    const ok = await runPush(60, (i) => a.send(frame(i)), { pace: noWait });
    expect(ok).toBe(true);
    await vi.waitFor(() => expect(delivered.length).toBe(60));
    expect(indexes(delivered)).toEqual(Array.from({ length: 60 }, (_, i) => i));
  });

  it("stops at a closed channel instead of sending past the hole", async () => {
    const { a, delivered } = await pair();
    const ok = await runPush(10, async (i) => {
      if (i === 4) a.close();
      return a.send(frame(i));
    }, { pace: noWait });
    expect(ok).toBe(false);
    // Nothing after the refusal went out: the receiver holds a clean prefix.
    await vi.waitFor(() => expect(delivered.length).toBe(4));
    expect(indexes(delivered)).toEqual([0, 1, 2, 3]);
  });
});
