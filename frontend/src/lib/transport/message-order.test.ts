import { describe, expect, it } from "vitest";
import { appendSorted, compareMessages } from "./message-order";
import type { Message } from "$lib/types/message";

const msg = (id: string, timestamp: number, lamport: number, senderId = "did:a"): Message =>
  ({ id, timestamp, lamport, senderId, roomCode: "r", senderName: "n", type: "text", content: id } as Message);

describe("clock-independent conversation order", () => {
  it("keeps a reply after the message it follows despite wildly wrong clocks", () => {
    const first = msg("a", Date.UTC(2036, 0, 1), 41);
    const reply = msg("b", Date.UTC(2001, 0, 1), 42, "did:b");
    expect(appendSorted([first], reply).map(m => m.id)).toEqual(["a", "b"]);
    expect(appendSorted([reply], first).map(m => m.id)).toEqual(["a", "b"]);
  });

  it("uses the same binary ID tie-break as storage, independent of sender and arrival order", () => {
    const messages = [msg("z", 1, 9, "did:a"), msg("A", 99, 9, "did:z"), msg("a", 2, 9)];
    expect([...messages].sort(compareMessages).map(m => m.id)).toEqual(["A", "a", "z"]);
    expect([...messages].reverse().sort(compareMessages).map(m => m.id)).toEqual(["A", "a", "z"]);
  });

  it("reopening legacy history changes its view order without changing original messages", () => {
    const messages = [msg("late-clock", 1, 22), msg("early-sequence", 9e12, 21)];
    const before = structuredClone(messages);
    expect([...messages].sort(compareMessages).map(m => m.id)).toEqual(["early-sequence", "late-clock"]);
    expect(messages).toEqual(before);
  });
});
