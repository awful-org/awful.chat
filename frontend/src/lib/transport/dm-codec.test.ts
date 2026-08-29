import { describe, expect, it } from "vitest";
import {
  DM_ACK_TAG,
  MAX_DM_TEXT_LENGTH,
  encodeDmAckEnvelope,
  encodeDmChatEnvelope,
  encodeDmReadEnvelope,
  hashDmRoomCode,
  parseDmEnvelope,
} from "./dm-codec";

describe("DM envelopes", () => {
  it("round-trips a chat envelope", () => {
    const payload = { id: "msg-1", text: "hello", ts: 1234567890 };
    const parsed = parseDmEnvelope(encodeDmChatEnvelope(payload));
    expect(parsed).toEqual({ type: "chat", payload });
  });

  it("round-trips a chat envelope with a lamport", () => {
    const payload = { id: "msg-l", text: "hi", ts: 1000, lamport: 2000 };
    const parsed = parseDmEnvelope(encodeDmChatEnvelope(payload));
    expect(parsed).toEqual({ type: "chat", payload });
  });

  it("strips a malformed lamport but keeps the message", () => {
    const raw = JSON.stringify({ id: "m", text: "hi", ts: 1, lamport: "x" });
    const bytes = new Uint8Array(1 + raw.length);
    bytes[0] = 0x01;
    bytes.set(new TextEncoder().encode(raw), 1);
    expect(parseDmEnvelope(bytes)).toEqual({
      type: "chat",
      payload: { id: "m", text: "hi", ts: 1 },
    });
  });

  it("round-trips a chat envelope with a reply quote", () => {
    const payload = {
      id: "msg-2",
      text: "sure",
      ts: 1234567891,
      replyTo: { id: "msg-1", senderName: "Alice", content: "lunch?" },
    };
    const parsed = parseDmEnvelope(encodeDmChatEnvelope(payload));
    expect(parsed).toEqual({ type: "chat", payload });
  });

  it("round-trips a reaction envelope", () => {
    const payload = {
      id: "msg-3",
      text: "\u2764\ufe0f",
      ts: 1234567892,
      reaction: { to: "msg-1", emoji: "\u2764\ufe0f", op: "add" as const },
    };
    const parsed = parseDmEnvelope(encodeDmChatEnvelope(payload));
    expect(parsed).toEqual({ type: "chat", payload });
  });

  it("strips a malformed replyTo but keeps the message", () => {
    const raw = JSON.stringify({
      id: "m",
      text: "hi",
      ts: 1,
      replyTo: { id: 5 },
    });
    const bytes = new Uint8Array(1 + raw.length);
    bytes[0] = 0x01;
    bytes.set(new TextEncoder().encode(raw), 1);
    const parsed = parseDmEnvelope(bytes);
    expect(parsed).toEqual({ type: "chat", payload: { id: "m", text: "hi", ts: 1 } });
  });

  it("strips a malformed reaction but keeps the message", () => {
    const raw = JSON.stringify({
      id: "m",
      text: "x",
      ts: 1,
      reaction: { to: "t", emoji: "x", op: "toggle" },
    });
    const bytes = new Uint8Array(1 + raw.length);
    bytes[0] = 0x01;
    bytes.set(new TextEncoder().encode(raw), 1);
    const parsed = parseDmEnvelope(bytes);
    expect(parsed).toEqual({ type: "chat", payload: { id: "m", text: "x", ts: 1 } });
  });

  it("round-trips an ack envelope", () => {
    const parsed = parseDmEnvelope(encodeDmAckEnvelope("msg-42"));
    expect(parsed).toEqual({ type: "ack", messageId: "msg-42" });
  });

  it("round-trips a read envelope with multiple ids", () => {
    const ids = ["a", "b", "c"];
    const parsed = parseDmEnvelope(encodeDmReadEnvelope(ids));
    expect(parsed).toEqual({ type: "read", messageIds: ids });
  });

  it("round-trips an empty read envelope", () => {
    expect(parseDmEnvelope(encodeDmReadEnvelope([]))).toEqual({
      type: "read",
      messageIds: [],
    });
  });

  it("rejects empty data", () => {
    expect(parseDmEnvelope(new Uint8Array(0))).toBeNull();
  });

  it("rejects unknown tags", () => {
    expect(parseDmEnvelope(new Uint8Array([0x7f, 1, 2, 3]))).toBeNull();
  });

  it("rejects malformed chat JSON", () => {
    const bad = new Uint8Array([0x01, ...new TextEncoder().encode("{nope")]);
    expect(parseDmEnvelope(bad)).toBeNull();
  });

  it("rejects chat text over the size cap", () => {
    const payload = { id: "m", text: "a".repeat(MAX_DM_TEXT_LENGTH + 1), ts: 1 };
    expect(parseDmEnvelope(encodeDmChatEnvelope(payload))).toBeNull();
  });

  it("accepts chat text at exactly the size cap", () => {
    const payload = { id: "m", text: "a".repeat(MAX_DM_TEXT_LENGTH), ts: 1 };
    expect(parseDmEnvelope(encodeDmChatEnvelope(payload))).toEqual({
      type: "chat",
      payload,
    });
  });

  it("rejects chat payloads with missing fields", () => {
    const bad = new Uint8Array([
      0x01,
      ...new TextEncoder().encode(JSON.stringify({ id: "x", text: 5, ts: 1 })),
    ]);
    expect(parseDmEnvelope(bad)).toBeNull();
  });

  it("rejects read payloads that are not string arrays", () => {
    const bad = new Uint8Array([
      0x03,
      ...new TextEncoder().encode(JSON.stringify(["ok", 42])),
    ]);
    expect(parseDmEnvelope(bad)).toBeNull();
  });

  it("uses distinct tags per envelope kind", () => {
    expect(encodeDmChatEnvelope({ id: "a", text: "b", ts: 1 })[0]).not.toBe(
      DM_ACK_TAG
    );
    expect(encodeDmAckEnvelope("a")[0]).toBe(DM_ACK_TAG);
  });
});

describe("hashDmRoomCode", () => {
  it("is order-independent and stable", async () => {
    const a = await hashDmRoomCode("did:key:alice", "did:key:bob");
    const b = await hashDmRoomCode("did:key:bob", "did:key:alice");
    expect(a).toBe(b);
    expect(a).toMatch(/^dm-[0-9a-f]{40}$/);
  });

  it("differs for different pairs", async () => {
    const ab = await hashDmRoomCode("did:key:alice", "did:key:bob");
    const ac = await hashDmRoomCode("did:key:alice", "did:key:carol");
    expect(ab).not.toBe(ac);
  });
});
