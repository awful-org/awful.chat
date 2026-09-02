import { describe, expect, it } from "vitest";
import {
  MessageType,
  boundReactionEmoji,
  boundReplyTo,
  isChatMessage,
  messageToWire,
  wireToMessage,
  type Message,
  type WireChatMessage,
} from "./message";
import { MAX_WIRE_NAME_LENGTH } from "$lib/wire-name";

const ROOM = "a1b2c3";

function wire(over: Partial<WireChatMessage> = {}): WireChatMessage {
  return {
    type: MessageType.Text,
    id: "m1",
    senderId: "did:key:zAlice",
    senderName: "Alice",
    timestamp: 1_700_000_000_000,
    lamport: 7,
    content: "hello",
    ...over,
  } as WireChatMessage;
}

const full: Message = {
  id: "id-1",
  roomCode: "room-x",
  senderId: "did:key:zAlice",
  senderName: "Alice",
  senderDid: "did:key:zAlice",
  sig: "aabb",
  timestamp: 111,
  lamport: 5,
  type: MessageType.Reply,
  content: "hi",
  attachments: ["att-1"],
  replyTo: { id: "id-0", senderName: "Bob", content: "yo" },
  status: "read",
};

describe("wire codec", () => {
  it("messageToWire strips storage-only fields", () => {
    const wire = messageToWire(full);
    expect(wire).not.toHaveProperty("roomCode");
    expect(wire).not.toHaveProperty("attachments");
    expect(wire).not.toHaveProperty("status");
    expect(wire.sig).toBe("aabb");
  });

  it("wireToMessage rebuilds a message for the local room", () => {
    const rebuilt = wireToMessage(messageToWire(full), "other-room");
    expect(rebuilt.roomCode).toBe("other-room");
    expect(rebuilt.attachments).toEqual([]);
    expect(rebuilt.content).toBe(full.content);
    expect(rebuilt.replyTo).toEqual(full.replyTo);
    expect(rebuilt.lamport).toBe(full.lamport);
  });

  it("isChatMessage accepts only persisted chat types", () => {
    expect(isChatMessage(messageToWire(full))).toBe(true);
    expect(
      isChatMessage({ type: MessageType.SyncComplete, roomCode: "r" })
    ).toBe(false);
    expect(
      isChatMessage({
        type: MessageType.Profile,
        name: "x",
        did: null,
        avatarUrl: null,
      })
    ).toBe(false);
  });
});

describe("wireToMessage: fields the signature does not cover", () => {
  it("keeps an ordinary past timestamp", () => {
    const ts = Date.now() - 5_000;
    expect(wireToMessage(wire({ timestamp: ts }), ROOM).timestamp).toBe(ts);
  });

  it("clamps a timestamp far in the future", () => {
    const before = Date.now();
    const got = wireToMessage(
      wire({ timestamp: 8_640_000_000_000_000 }),
      ROOM
    ).timestamp;
    // compareMessages sorts by timestamp first, so an unclamped value pins
    // the message to the bottom of everyone's timeline forever.
    expect(got).toBeGreaterThanOrEqual(before);
    expect(got).toBeLessThanOrEqual(Date.now() + 5 * 60_000);
  });

  it("falls back to now for a junk timestamp", () => {
    const before = Date.now();
    for (const bad of [NaN, Infinity, -1, 0, "soon", undefined]) {
      const got = wireToMessage(
        wire({ timestamp: bad as never }),
        ROOM
      ).timestamp;
      expect(got).toBeGreaterThanOrEqual(before);
    }
  });

  it("strips and caps the sender name", () => {
    const w = wire({ senderName: "Ali\u202Ece\u0000" });
    expect(wireToMessage(w, ROOM).senderName).toBe("Alice");
    const long = wire({ senderName: "z".repeat(MAX_WIRE_NAME_LENGTH + 20) });
    expect(wireToMessage(long, ROOM).senderName).toHaveLength(
      MAX_WIRE_NAME_LENGTH
    );
  });

  it("strips the reply snapshot's author too", () => {
    const w = wire({
      type: MessageType.Reply,
      replyTo: { id: "m0", senderName: "B\u202Eob", content: "hi" },
    });
    expect(wireToMessage(w, ROOM).replyTo?.senderName).toBe("Bob");
  });
});

describe("boundReplyTo", () => {
  it("caps a long snapshot", () => {
    const r = boundReplyTo({
      id: "m0",
      senderName: "Bob",
      content: "x".repeat(5000),
    });
    expect(r?.content).toHaveLength(2048);
  });

  it("coerces a non-string snapshot to empty", () => {
    const r = boundReplyTo({
      id: "m0",
      senderName: "Bob",
      content: 42 as never,
    });
    expect(r?.content).toBe("");
  });

  it("returns the same object when nothing needs changing", () => {
    const r = { id: "m0", senderName: "Bob", content: "hi" };
    expect(boundReplyTo(r)).toBe(r);
  });
});

describe("boundReactionEmoji", () => {
  it("keeps an ordinary emoji", () => {
    expect(boundReactionEmoji("\u{1F44D}")).toBe("\u{1F44D}");
  });

  it("caps a pathological one", () => {
    expect(boundReactionEmoji("a".repeat(10_000))).toHaveLength(32);
  });

  it("drops control characters, and an all-control value entirely", () => {
    expect(boundReactionEmoji("\u0000\u202E")).toBeUndefined();
  });

  it("passes undefined through", () => {
    expect(boundReactionEmoji(undefined)).toBeUndefined();
    expect(boundReactionEmoji(5)).toBeUndefined();
  });
});
