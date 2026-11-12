import { describe, expect, it } from "vitest";
import { dmInboxNotice, queuedReceiptTip, relayCopyCounts } from "./dm-inbox-notice";

const base = { peerName: "Ada", peerOnline: false, theirInboxOff: false, myInboxOff: false };

describe("dmInboxNotice", () => {
  it("says nothing when both inboxes are on", () => {
    expect(dmInboxNotice(base)).toBeNull();
  });

  it("says nothing while they are online, whatever the inboxes", () => {
    expect(
      dmInboxNotice({ ...base, peerOnline: true, theirInboxOff: true, myInboxOff: true })
    ).toBeNull();
  });

  it("names whose inbox is off", () => {
    expect(dmInboxNotice({ ...base, theirInboxOff: true })).toMatch(/^Ada has their offline inbox off/);
    expect(dmInboxNotice({ ...base, myInboxOff: true })).toMatch(/^Your offline inbox is off/);
    expect(dmInboxNotice({ ...base, theirInboxOff: true, myInboxOff: true })).toMatch(
      /^Both your offline inboxes are off/
    );
  });
});

describe("the single tick for a copy left in the relay", () => {
  it("is earned when their inbox is on", () => {
    expect(relayCopyCounts("sent", false)).toBe(true);
  });

  it("is not earned when their inbox is off: nobody collects that copy", () => {
    expect(relayCopyCounts("sent", true)).toBe(false);
  });

  it("is not earned when no copy was left", () => {
    for (const result of ["oversized", "failed", "disabled"] as const) {
      expect(relayCopyCounts(result, false)).toBe(false);
    }
  });
});

describe("the clock's tooltip", () => {
  const none = { tooLongForInbox: false, myInboxOff: false, theirInboxOff: false };

  it("says it waits in their inbox when both inboxes are on", () => {
    expect(queuedReceiptTip(none)).toBe("Queued - waiting in their offline inbox");
  });

  it("says it needs you both online when their inbox is off", () => {
    expect(queuedReceiptTip({ ...none, theirInboxOff: true })).toBe(
      "Queued - their offline inbox is off, so it sends when you are both online",
    );
  });

  it("puts a message too long for the inbox, then your own inbox, first", () => {
    expect(queuedReceiptTip({ tooLongForInbox: true, myInboxOff: true, theirInboxOff: true }))
      .toBe("Too long for the offline inbox, sends when they are online");
    expect(queuedReceiptTip({ ...none, myInboxOff: true, theirInboxOff: true }))
      .toBe("Queued - will send when the recipient is reachable");
  });
});
