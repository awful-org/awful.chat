import { describe, expect, it } from "vitest";
import { dmInboxNotice } from "./dm-inbox-notice";

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
