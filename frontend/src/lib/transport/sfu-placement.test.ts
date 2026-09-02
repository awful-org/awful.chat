import { describe, expect, it } from "vitest";
import { isMisplaced, SFU_MISPLACED_MESSAGE } from "./sfu-placement";

describe("isMisplaced", () => {
  it("fires when we know somebody is here and the server says nobody is", () => {
    // The measured shape: presence has two peers in the call room, the SFU
    // hands the joiner roomPeerCount 0, announces no producer, and the
    // receive transport is never built.
    expect(
      isMisplaced({ expectedOthers: 1, sessionLive: true, reportedByServer: 0 })
    ).toBe(true);
  });

  it("stays silent for the first person in the call", () => {
    // Zero is the correct answer for whoever arrives first, and this check
    // runs on their join too.
    expect(
      isMisplaced({ expectedOthers: 0, sessionLive: true, reportedByServer: 0 })
    ).toBe(false);
  });

  it("stays silent when the server agrees somebody is there", () => {
    expect(
      isMisplaced({ expectedOthers: 1, sessionLive: true, reportedByServer: 1 })
    ).toBe(false);
  });

  it("stays silent on an undercount, which can just be a peer mid-join", () => {
    // Crying wolf on a transient disagreement would make the real signal
    // worthless, so only an empty room counts.
    expect(
      isMisplaced({ expectedOthers: 3, sessionLive: true, reportedByServer: 2 })
    ).toBe(false);
  });

  it("stays silent when the SFU session is not usable", () => {
    // A session that never came up has its own error path; reporting a
    // placement fault on top would send the reader somewhere useless.
    expect(
      isMisplaced({ expectedOthers: 2, sessionLive: false, reportedByServer: 0 })
    ).toBe(false);
  });

  it("says what the person should do about it", () => {
    // The one thing that helps is hanging up and starting again, so the
    // message has to say so rather than name a component.
    expect(SFU_MISPLACED_MESSAGE).toMatch(/voice works/i);
    expect(SFU_MISPLACED_MESSAGE).toMatch(/rejoining/i);
  });
});
