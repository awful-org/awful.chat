import { describe, expect, it } from "vitest";
import { appendSorted } from "./message-order";
import type { Message } from "$lib/types/message";

const msg = (
  id: string,
  timestamp: number,
  lamport: number,
  senderId = "did:a"
): Message =>
  ({ id, timestamp, lamport, senderId, roomCode: "r", senderName: "n",
     type: "text", content: id } as unknown as Message);

const DAY = 86_400_000;

describe("timeline ordering", () => {
  // The bug this exists for: two peers who have not heard from each other
  // advance their lamport counters independently, so a peer whose counter is
  // behind can send today and land above a message from yesterday. On screen
  // that put "Today" above "Yesterday".
  it("puts an older message first even when its lamport is higher", () => {
    const yesterday = msg("yesterday", 1_000_000, 50, "did:reng");
    const today = msg("today", 1_000_000 + DAY, 13, "did:dboll");
    const out = appendSorted([today], yesterday);
    expect(out.map((m) => m.id)).toEqual(["yesterday", "today"]);
  });

  it("appends in order without a re-sort when time already agrees", () => {
    const a = msg("a", 1, 1);
    const b = msg("b", 2, 2);
    expect(appendSorted([a], b).map((m) => m.id)).toEqual(["a", "b"]);
  });

  // Lamport still decides inside a millisecond, so causally ordered messages
  // sent in the same tick do not shuffle.
  it("falls back to lamport within one millisecond", () => {
    const second = msg("second", 5_000, 9);
    const first = msg("first", 5_000, 2);
    expect(appendSorted([second], first).map((m) => m.id)).toEqual([
      "first",
      "second",
    ]);
  });

  // And senderId last, so two peers stamping the same ms and the same
  // counter still agree on an order rather than rendering differently on
  // each screen.
  it("is deterministic across peers when time and lamport both tie", () => {
    const z = msg("z", 7, 7, "did:zeta");
    const a = msg("a", 7, 7, "did:alpha");
    expect(appendSorted([z], a).map((m) => m.id)).toEqual(["a", "z"]);
    expect(appendSorted([a], z).map((m) => m.id)).toEqual(["a", "z"]);
  });
});
