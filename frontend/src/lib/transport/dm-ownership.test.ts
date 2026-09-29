import { describe, expect, it, vi } from "vitest";
import { MessageType, type WireChatMessage } from "$lib/types/message";

const identity = vi.hoisted(() => ({ session: { did: "did:alice" } as { did: string } | null }));
vi.mock("$lib/identity/identity", () => ({
  requireSession: () => {
    if (!identity.session) throw new Error("Locked");
    return identity.session;
  },
}));
import { allowsUnsignedDmHistory, captureDmOwnership } from "./dm-ownership";

function row(type: MessageType, senderId = "did:alice"): WireChatMessage {
  return { type, senderId, id: "old-message", timestamp: 1, content: "history" } as WireChatMessage;
}

describe("unsigned DM repair policy", () => {
  it("accepts only the authorized author's historical text-like rows", () => {
    for (const type of [MessageType.Text, MessageType.Reply, MessageType.Reaction]) {
      expect(allowsUnsignedDmHistory(row(type), "did:alice", false)).toBe(true);
      expect(allowsUnsignedDmHistory(row(type), "did:bob", false)).toBe(false);
      expect(allowsUnsignedDmHistory(row(type), null, false)).toBe(false);
      expect(allowsUnsignedDmHistory(row(type), "*", false)).toBe(true);
      expect(allowsUnsignedDmHistory(row(type), "*", true)).toBe(false);
    }
  });
  it("never exempts file or plugin rows even when labeled as own-device history", () => {
    for (const type of [MessageType.File, MessageType.PluginCard, MessageType.PluginUpdate]) {
      for (const live of [false, true]) {
        expect(allowsUnsignedDmHistory(row(type), "*", live)).toBe(false);
        expect(allowsUnsignedDmHistory(row(type), "did:alice", live)).toBe(false);
      }
    }
  });
  it("rejects attachments disguised as unsigned text history", () => {
    const message = row(MessageType.Text);
    message.meta = { files: [{ infoHash: "ciphertext" }] } as WireChatMessage["meta"];
    expect(allowsUnsignedDmHistory(message, "*", false)).toBe(false);
  });
});

it("revokes pending work on lock or a new session with the same DID", () => {
  identity.session = { did: "did:alice" };
  const guard = captureDmOwnership();
  expect(guard).not.toThrow();
  identity.session = null;
  expect(guard).toThrow("Locked");
  identity.session = { did: "did:alice" };
  expect(guard).toThrow("Identity changed");
});
