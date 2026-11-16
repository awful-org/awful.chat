import { describe, expect, it } from "vitest";
import {
  SendWindow,
  formatComparisonCode,
  manifestProblems,
  newSyncNonce,
  syncComparisonCode,
  type ReceivedSection,
} from "./sync-protocol";

const SOURCE = "12D3KooW" + "S".repeat(44);
const TARGET = "12D3KooW" + "T".repeat(44);
const TOKEN = "0123456789abcdef0123456789abcdef";

// The code is what a person compares between two screens before allowing a
// sync, so it has to come out the same from both ends' own inputs, and
// differently for anybody else who asks with the same token.
describe("syncComparisonCode", () => {
  it("is six digits both ends derive alike", () => {
    const nonce = newSyncNonce();
    const code = syncComparisonCode(SOURCE, TARGET, TOKEN, nonce);
    expect(code).toMatch(/^\d{6}$/);
    expect(syncComparisonCode(SOURCE, TARGET, TOKEN, nonce)).toBe(code);
  });

  it("differs for another requester, another token and another request", () => {
    const nonce = "a".repeat(32);
    const code = syncComparisonCode(SOURCE, TARGET, TOKEN, nonce);
    // Over a handful of inputs a six-digit collision is a one-in-a-million
    // coincidence, which a test can afford to treat as a bug.
    expect(syncComparisonCode(SOURCE, "12D3KooW" + "X".repeat(44), TOKEN, nonce)).not.toBe(code);
    expect(syncComparisonCode(SOURCE, TARGET, "f".repeat(32), nonce)).not.toBe(code);
    expect(syncComparisonCode(SOURCE, TARGET, TOKEN, "b".repeat(32))).not.toBe(code);
    expect(syncComparisonCode(TARGET, SOURCE, TOKEN, nonce)).not.toBe(code);
  });

  it("reads in two groups of three", () => {
    expect(formatComparisonCode("012345")).toBe("012 345");
  });

  it("makes a fresh 128-bit nonce for every request", () => {
    const a = newSyncNonce();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(newSyncNonce()).not.toBe(a);
  });
});

// The receiving channel closes the stream past 32 frames or 4MB it has not
// processed, and the source used to pace itself with a 10ms sleep.
describe("SendWindow", () => {
  it("lets a bounded number of frames out, and one more per ack", async () => {
    const window = new SendWindow(2, 1_000);
    await window.reserve(10);
    window.sent(0, 10);
    await window.reserve(10);
    window.sent(1, 10);
    let third = false;
    const waiting = window.reserve(10).then(() => { third = true; });
    await Promise.resolve();
    expect(third).toBe(false);
    expect(window.ack(0)).toBe(true);
    await waiting;
    expect(third).toBe(true);
  });

  it("bounds the bytes out, but never stops a lone frame bigger than the budget", async () => {
    const window = new SendWindow(4, 100);
    await window.reserve(500);
    window.sent(0, 500);
    let next = false;
    const waiting = window.reserve(10).then(() => { next = true; });
    await Promise.resolve();
    expect(next).toBe(false);
    window.ack(0);
    await waiting;
    expect(next).toBe(true);
  });

  it("ignores acks for frames it never sent, or sent and already acked", () => {
    const window = new SendWindow(2, 100);
    window.sent(0, 10);
    expect(window.ack(5)).toBe(false);
    expect(window.ack("0")).toBe(false);
    expect(window.ack(0)).toBe(true);
    expect(window.ack(0)).toBe(false);
    expect(window.pending).toBe(0);
  });

  it("drains only once everything sent was acked", async () => {
    const window = new SendWindow(4, 1_000);
    window.sent(0, 10);
    window.sent(1, 10);
    let drained = false;
    const done = window.drained().then(() => { drained = true; });
    window.ack(0);
    await Promise.resolve();
    expect(drained).toBe(false);
    window.ack(1);
    await done;
    expect(drained).toBe(true);
  });

  it("fails whoever waits, and whoever asks next", async () => {
    const window = new SendWindow(1, 100);
    window.sent(0, 10);
    const waiting = window.reserve(10);
    window.fail(new Error("Connection lost"));
    await expect(waiting).rejects.toThrow("Connection lost");
    await expect(window.reserve(1)).rejects.toThrow("Connection lost");
    await expect(window.drained()).rejects.toThrow("Connection lost");
  });
});

describe("manifestProblems", () => {
  const got = (items: number, batches: number[], announced = batches.length): ReceivedSection =>
    ({ items, batches: new Set(batches), announced });

  it("passes a transfer that holds exactly what the manifest lists", () => {
    const received = new Map([["messages", got(120, [0, 1, 2])]]);
    expect(manifestProblems({
      messages: { items: 120, batches: 3 },
      rooms: { items: 0, batches: 0 },
    }, received, ["messages", "rooms"])).toEqual([]);
  });

  // The batch counts on the frames could not see this: a one-batch section
  // whose only frame was lost announced nothing, so nothing was short.
  it("catches a section that never arrived at all", () => {
    expect(manifestProblems({ rooms: { items: 3, batches: 1 } }, new Map(), ["rooms"]))
      .toEqual(["rooms (0/3)"]);
  });

  it("catches a missing batch, a short count and a size the frames disagreed on", () => {
    expect(manifestProblems({ messages: { items: 120, batches: 3 } },
      new Map([["messages", got(80, [0, 2])]]), ["messages"])).toEqual(["messages (80/120)"]);
    expect(manifestProblems({ messages: { items: 120, batches: 3 } },
      new Map([["messages", got(119, [0, 1, 2])]]), ["messages"])).toEqual(["messages (119/120)"]);
    expect(manifestProblems({ messages: { items: 120, batches: 3 } },
      new Map([["messages", got(120, [0, 1, 2], Number.NaN)]]), ["messages"])).toEqual(["messages (120/120)"]);
  });

  it("refuses a manifest that leaves out a section, or that is not one", () => {
    expect(manifestProblems({}, new Map(), ["rooms"])).toEqual(["rooms (not listed)"]);
    expect(manifestProblems(undefined, new Map(), ["rooms"])).toEqual(["no manifest"]);
    expect(manifestProblems({ rooms: { items: -1, batches: 0 } }, new Map(), ["rooms"]))
      .toEqual(["rooms (bad manifest entry)"]);
    expect(manifestProblems({ rooms: { items: 0, batches: 0 } },
      new Map([["extra", got(1, [0])]]), ["rooms"])).toEqual(["extra (not listed)"]);
  });
});
