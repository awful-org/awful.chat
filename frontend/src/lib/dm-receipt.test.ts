import { describe, expect, it } from "vitest";
import { dmReceiptIds } from "./dm-receipt";
import type { Message } from "./types/message";

function msg(id: string, senderId: string, status?: Message["status"]): Message {
  return { id, senderId, status } as Message;
}
const own = (id: string) => id === "me";

describe("DM receipts", () => {
  it("collapses a chain with one status onto its last message", () => {
    expect(dmReceiptIds([
      msg("older-read", "me", "read"),
      msg("theirs", "them", "read"),
      msg("newer-read", "me", "read"),
    ], own)).toEqual(["newer-read"]);
    expect(dmReceiptIds([
      msg("first", "me", "delivered"),
      msg("second", "me", "delivered"),
      msg("third", "me", "delivered"),
    ], own)).toEqual(["third"]);
  });

  it("does not mark the first message of a chain that follows another status", () => {
    expect(dmReceiptIds([
      msg("read-1", "me", "read"),
      msg("read-2", "me", "read"),
      msg("delivered-1", "me", "delivered"),
      msg("delivered-2", "me", "delivered"),
      msg("delivered-3", "me", "delivered"),
    ], own)).toEqual(["read-2", "delivered-3"]);
  });

  it("shows a message whose status differs from the ones around it", () => {
    expect(dmReceiptIds([
      msg("read-1", "me", "read"),
      msg("delivered", "me", "delivered"),
      msg("read-2", "me", "read"),
      msg("read-3", "me", "read"),
    ], own)).toEqual(["read-1", "delivered", "read-3"]);
  });

  it("gives every status its own receipt, pending ones included", () => {
    expect(dmReceiptIds([
      msg("sent", "me", "sent"),
      msg("delivered", "me", "delivered"),
      msg("read", "me", "read"),
    ], own)).toEqual(["sent", "delivered", "read"]);
    expect(dmReceiptIds([
      msg("delivered", "me", "delivered"),
      msg("sending", "me", "sending"),
    ], own)).toEqual(["delivered", "sending"]);
  });

  it("skips own messages with no status and other people's statuses", () => {
    expect(dmReceiptIds([
      msg("mine", "me", "read"),
      msg("theirs", "them", "read"),
      msg("draft", "me"),
    ], own)).toEqual(["mine"]);
    expect(dmReceiptIds([msg("theirs", "them", "read")], own)).toEqual([]);
  });
});
