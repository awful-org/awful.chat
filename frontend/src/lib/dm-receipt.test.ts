import { describe, expect, it } from "vitest";
import { dmReceiptIds } from "./dm-receipt";
import type { Message } from "./types/message";

function msg(id: string, senderId: string, status?: Message["status"]): Message {
  return { id, senderId, status } as Message;
}
const own = (id: string) => id === "me";

describe("DM receipts", () => {
  it("keeps only the newest status in a uniform or normally progressing chain", () => {
    expect(dmReceiptIds([
      msg("older-read", "me", "read"),
      msg("theirs", "them", "read"),
      msg("newer-read", "me", "read"),
    ], own)).toEqual(["newer-read"]);
    expect(dmReceiptIds([
      msg("sent", "me", "sent"),
      msg("delivered", "me", "delivered"),
      msg("read", "me", "read"),
    ], own)).toEqual(["read"]);
  });

  it("shows a pending newest state instead of an older delivered tick", () => {
    expect(dmReceiptIds([
      msg("delivered", "me", "delivered"),
      msg("sending", "me", "sending"),
    ], own)).toEqual(["sending"]);
  });

  it("keeps the oldest earlier status that is behind a later one", () => {
    expect(dmReceiptIds([
      msg("older-read", "me", "read"),
      msg("third-last-delivered", "me", "delivered"),
      msg("penultimate-read", "me", "read"),
      msg("latest-read", "me", "read"),
    ], own)).toEqual(["third-last-delivered", "latest-read"]);
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
