import { describe, it, expect } from "vitest";
import { peerCallChime } from "./call-chime";

const room1 = { roomCode: "room1", voiceChannel: "" };
const base = {
  imInCall: true,
  myCall: room1,
  before: null,
  after: room1,
};

describe("peerCallChime", () => {
  it("chimes when someone joins the call we are in", () => {
    expect(peerCallChime(base)).toBe("join");
  });

  it("chimes when someone leaves the call we are in", () => {
    expect(peerCallChime({ ...base, before: room1, after: null })).toBe("leave");
  });

  // Presence is rebroadcast to every peer on connect. Without this, joining a
  // call with four people in it would fire four chimes at once.
  it("stays silent when the presence message changes nothing", () => {
    expect(peerCallChime({ ...base, before: room1, after: room1 })).toBeNull();
    expect(peerCallChime({ ...base, before: null, after: null })).toBeNull();
  });

  it("stays silent for a call happening in another room", () => {
    const room2 = { roomCode: "room2", voiceChannel: "" };
    expect(peerCallChime({ ...base, after: room2 })).toBeNull();
    expect(peerCallChime({ ...base, before: room2, after: null })).toBeNull();
  });

  it("stays silent when we are not in a call ourselves", () => {
    expect(peerCallChime({ ...base, imInCall: false })).toBeNull();
    expect(peerCallChime({ ...base, myCall: null })).toBeNull();
  });

  it("stays silent for another voice channel of the same room", () => {
    const lounge = { roomCode: "room1", voiceChannel: "lounge0001" };
    expect(peerCallChime({ ...base, after: lounge })).toBeNull();
    expect(peerCallChime({ ...base, before: lounge, after: null })).toBeNull();
  });

  // Moving between channels never passes through "not in a call", so a test
  // of "were they in a call at all" would give neither side a sound.
  it("is a join for the channel they move into and a leave for the one they left", () => {
    const lounge = { roomCode: "room1", voiceChannel: "lounge0001" };
    expect(peerCallChime({ ...base, before: lounge, after: room1 })).toBe("join");
    expect(peerCallChime({ ...base, before: room1, after: lounge })).toBe("leave");
    expect(peerCallChime({ ...base, myCall: lounge, before: room1, after: lounge })).toBe("join");
  });
});
