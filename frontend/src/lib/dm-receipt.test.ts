import { describe, expect, it } from "vitest";
import { latestDmReceiptId } from "./dm-receipt";
import type { Message } from "./types/message";

function msg(id: string, senderId: string, status?: Message["status"]): Message {
  return { id, senderId, status } as Message;
}
const own = (id: string) => id === "me";

describe("latest DM receipt", () => {
  it("keeps only the newest own status, which summarizes earlier messages", () => {
    expect(latestDmReceiptId([
      msg("older-read", "me", "read"),
      msg("theirs", "them", "read"),
      msg("newer-sent", "me", "sent"),
    ], own)).toBe("newer-sent");
  });

  it("shows a pending newest state instead of an older delivered tick", () => {
    expect(latestDmReceiptId([
      msg("delivered", "me", "delivered"),
      msg("sending", "me", "sending"),
    ], own)).toBe("sending");
  });

  it("skips own messages with no status and other people's statuses", () => {
    expect(latestDmReceiptId([
      msg("mine", "me", "read"),
      msg("theirs", "them", "read"),
      msg("draft", "me"),
    ], own)).toBe("mine");
    expect(latestDmReceiptId([msg("theirs", "them", "read")], own)).toBeNull();
  });
});
