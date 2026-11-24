import { beforeAll, describe, expect, it } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import {
  canonicalContentV3,
  canonicalContentV4,
  canonicalFor,
  signMessage,
  verifyMessage,
} from "../messaging";
import { createIdentity, requireSession } from "../identity/identity";
import { verifyIncoming, _resetVerifiedSignatures } from "./verify-incoming";
import { MessageType, messageToWire, wireToMessage, type Message, type WireChatMessage } from "../types/message";
import { newMessageId } from "../message-id";
import { hex, utf8 } from "../utils";
import { newChannelId } from "../channels";

// The channel tag rides the signature (sigV 4), and only on a channel
// message: everything in the original chat stays exactly what it was.

const ROOM = "rd2_channels";

function message(over: Partial<Message> = {}): Message {
  const did = requireSession().did;
  return {
    id: newMessageId(did),
    roomCode: ROOM,
    senderId: did,
    senderName: "Me",
    timestamp: Date.now(),
    lamport: 3,
    type: MessageType.Text,
    content: "hello",
    attachments: [],
    ...over,
  };
}

beforeAll(async () => {
  await createIdentity("correct horse battery staple");
});

describe("signing a channel message", () => {
  it("signs the original chat as v3 and a channel as v4", async () => {
    expect(signMessage(message()).sigV).toBe(3);
    const tagged = signMessage(message({ channel: newChannelId() }));
    expect(tagged.sigV).toBe(4);
    expect(await verifyMessage(tagged)).toBe(true);
  });

  it("a tagged message cannot be moved into another channel, or out of channels", async () => {
    const signed = signMessage(message({ channel: newChannelId() }));
    expect(await verifyMessage({ ...signed, channel: newChannelId() })).toBe(false);
    expect(await verifyMessage({ ...signed, channel: undefined })).toBe(false);
    // Nor downgraded to v3 with the tag dropped: the v3 canonical differs.
    expect(await verifyMessage({ ...signed, channel: undefined, sigV: 3 })).toBe(false);
  });

  it("an original-chat message cannot be pulled into a channel", async () => {
    const signed = signMessage(message());
    expect(await verifyMessage({ ...signed, channel: newChannelId(), sigV: 4 })).toBe(false);
  });

  it("v4 is v3 with the channel, and nothing else of v3 drops out", () => {
    const m = message({ channel: newChannelId(), reactionTo: "x", reactionEmoji: "🙂", reactionOp: "add" });
    const v3 = JSON.parse(canonicalContentV3(m)) as unknown[];
    const v4 = JSON.parse(canonicalContentV4(m)) as unknown[];
    expect(v4[0]).toBe(4);
    expect(v4[3]).toBe(m.channel);
    expect([v4[1], v4[2], ...v4.slice(4)]).toEqual(v3.slice(1));
  });

  // What an older build does with one. Its verifyIncoming accepts sigV 3 and
  // nothing else ("sig-version"), so the message is dropped, never shown in
  // the original chat. Its canonicalFor falls back to v1 for a version it
  // does not know; a v4 signature cannot verify against that either.
  it("an older build's fallback canonical does not verify a v4 signature", async () => {
    const signed = signMessage(message({ channel: newChannelId() }));
    const legacy = { ...signed, sigV: undefined };
    expect(canonicalFor(legacy)).not.toBe(canonicalFor(signed));
    expect(await verifyMessage(legacy)).toBe(false);
  });

  it("the wire form carries the tag both ways, and only when there is one", () => {
    const channel = newChannelId();
    const tagged = signMessage(message({ channel }));
    const wire = messageToWire(tagged);
    expect(wire.channel).toBe(channel);
    expect(wireToMessage(wire, ROOM).channel).toBe(channel);
    const plain = messageToWire(signMessage(message()));
    expect("channel" in plain).toBe(false);
    expect("channel" in wireToMessage(plain, ROOM)).toBe(false);
  });
});

describe("verifyIncoming and the channel tag", () => {
  const wireOf = (m: Message): WireChatMessage => messageToWire(m);

  it("accepts a v4 channel message signed for this room", async () => {
    _resetVerifiedSignatures();
    const w = wireOf(signMessage(message({ channel: newChannelId() })));
    expect(await verifyIncoming(w, { room: ROOM })).toEqual({ ok: true });
  });

  it("refuses one re-filed into another channel", async () => {
    const w = wireOf(signMessage(message({ channel: newChannelId() })));
    expect(await verifyIncoming({ ...w, channel: newChannelId() }, { room: ROOM }))
      .toEqual({ ok: false, reason: "bad-signature" });
  });

  it("refuses a channel on a v3 message, where it would be unsigned", async () => {
    const w = wireOf(signMessage(message()));
    expect(await verifyIncoming({ ...w, channel: newChannelId() }, { room: ROOM }))
      .toEqual({ ok: false, reason: "channel" });
  });

  it("refuses a v4 message without a channel", async () => {
    const m = message();
    const sig = ed25519.sign(utf8(canonicalContentV4(m)), requireSession().privateKey);
    const w = { ...wireOf(m), senderDid: m.senderId, sig: hex(sig), sigV: 4 };
    expect(await verifyIncoming(w, { room: ROOM })).toEqual({ ok: false, reason: "channel" });
  });

  it("refuses a malformed channel id, signed or not", async () => {
    for (const channel of ["", "UPPER-case", "short", "a".repeat(33), 7 as unknown as string, null as unknown as string]) {
      const m = message({ channel });
      const sig = ed25519.sign(utf8(canonicalContentV4(m)), requireSession().privateKey);
      const w = { ...wireOf(m), channel, senderDid: m.senderId, sig: hex(sig), sigV: 4 };
      expect(await verifyIncoming(w, { room: ROOM })).toEqual({ ok: false, reason: "channel" });
      expect(await verifyIncoming({ ...w, sig: undefined }, { room: ROOM, allowUnsigned: true }))
        .toEqual({ ok: false, reason: "channel" });
    }
  });

  it("refuses a channel in a DM, which has none", async () => {
    const m = message({ roomCode: "dm-abc", channel: newChannelId() });
    const w = wireOf(signMessage(m));
    expect(await verifyIncoming(w, { room: "dm-abc" })).toEqual({ ok: false, reason: "channel" });
  });
});
