import { describe, expect, it } from "vitest";
import { MessageType, type Message } from "./types/message";
import { tallyReactions } from "./reaction-tally";

let seq = 0;
function message(over: Partial<Message> = {}): Message {
  seq += 1;
  return {
    id: `m${seq}`,
    roomCode: "room",
    senderId: "did:key:alice",
    senderName: "Alice",
    timestamp: seq,
    lamport: seq,
    type: MessageType.Text,
    content: "hi",
    attachments: [],
    ...over,
  };
}

function reaction(to: string, emoji: string, senderId: string, op?: "add" | "remove"): Message {
  return message({
    type: MessageType.Reaction,
    content: "",
    reactionTo: to,
    reactionEmoji: emoji,
    reactionOp: op,
    senderId,
  });
}

/** peerId "12D3bob" is Bob's DID once bound. */
const reactorOf = (id: string) => (id === "12D3bob" ? "did:key:bob" : id);

describe("reaction tally", () => {
  it("tallies who reacted with what, one person once whatever id they carry", () => {
    const list = [
      message({ id: "a" }),
      reaction("a", "👍", "did:key:alice"),
      reaction("a", "👍", "12D3bob"),
      reaction("a", "🔥", "did:key:bob"),
      reaction("a", "👍", "did:key:bob", "remove"),
    ];
    const tally = tallyReactions(list, reactorOf);
    expect([...tally.get("a")!.keys()]).toEqual(["👍", "🔥"]);
    expect([...tally.get("a")!.get("👍")!]).toEqual(["did:key:alice"]);
    expect([...tally.get("a")!.get("🔥")!]).toEqual(["did:key:bob"]);
  });

  it("keeps the same Map for every message whose reactions did not change", () => {
    const list = [
      message({ id: "a" }),
      message({ id: "b" }),
      reaction("a", "👍", "did:key:alice"),
      reaction("b", "🔥", "did:key:bob"),
    ];
    const first = tallyReactions(list, reactorOf);

    // A plain message lands: nobody's reactions moved.
    const second = tallyReactions([...list, message({ id: "c" })], reactorOf, first);
    expect(second.get("a")).toBe(first.get("a"));
    expect(second.get("b")).toBe(first.get("b"));

    // A reaction on b: only b's tally is new.
    const third = tallyReactions(
      [...list, reaction("b", "🔥", "did:key:alice")],
      reactorOf,
      second
    );
    expect(third.get("a")).toBe(first.get("a"));
    expect(third.get("b")).not.toBe(first.get("b"));
    expect([...third.get("b")!.get("🔥")!]).toEqual(["did:key:bob", "did:key:alice"]);
  });

  it("takes a different order of people for a change: the names show in it", () => {
    const one = [message({ id: "a" }), reaction("a", "👍", "did:key:alice"), reaction("a", "👍", "did:key:bob")];
    const other = [message({ id: "a" }), reaction("a", "👍", "did:key:bob"), reaction("a", "👍", "did:key:alice")];
    const first = tallyReactions(one, reactorOf);
    expect(tallyReactions(other, reactorOf, first).get("a")).not.toBe(first.get("a"));
  });
});
