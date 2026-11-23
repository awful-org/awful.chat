import { describe, expect, it } from "vitest";
import {
  callFromPresence,
  callPresenceFields,
  isChannelId,
  isVoiceChannel,
  peersInCall,
  voiceChannelRoster,
} from "./voice-channel";
import { MessageType } from "$lib/types/message";

const ROOM = "rd2_room";

describe("channel ids", () => {
  it.each(["lounge01", "a".repeat(32), "0123456789"])("accepts %s", (id) => {
    expect(isChannelId(id)).toBe(true);
    expect(isVoiceChannel(id)).toBe(true);
  });

  it.each(["", "short", "a".repeat(33), "Lounge01", "lounge-01", "lounge_01", " lounge01", "lounge01\n", 12345678, null, undefined, {}])(
    "refuses %j as a channel id",
    (id) => {
      expect(isChannelId(id)).toBe(false);
    },
  );

  it("knows the default channel as a voice channel but not as a channel id", () => {
    expect(isVoiceChannel("")).toBe(true);
    expect(isChannelId("")).toBe(false);
  });
});

describe("call presence on the wire", () => {
  const frame = (fields: object) => ({ type: MessageType.CallPresence, ...fields });

  // An old client, a DM, anybody on the default call: the frame they have
  // always sent means the room's default channel.
  it("reads a frame with no channel field as the default channel", () => {
    expect(callFromPresence(frame({ inCall: true, roomCode: ROOM }))).toEqual({ roomCode: ROOM, voiceChannel: "" });
  });

  it("writes the default channel exactly as before", () => {
    expect(callPresenceFields({ roomCode: ROOM, voiceChannel: "" })).toEqual({ inCall: true, roomCode: ROOM });
    expect(callPresenceFields(null)).toEqual({ inCall: false, roomCode: undefined });
  });

  it("round-trips a channel", () => {
    const call = { roomCode: ROOM, voiceChannel: "lounge01" };
    expect(callFromPresence(frame(callPresenceFields(call)))).toEqual(call);
  });

  // What an old client reads is `inCall` and `roomCode`. A channel frame has
  // no roomCode, which to it is "in no call it can name": it does not count
  // somebody in a channel it cannot join as a member of its default call.
  it("leaves roomCode out of a channel frame, so an old client sees no call", () => {
    const fields = callPresenceFields({ roomCode: ROOM, voiceChannel: "lounge01" });
    expect(fields).not.toHaveProperty("roomCode");
    expect(fields).toEqual({ inCall: true, voiceRoomCode: ROOM, voiceChannel: "lounge01" });
  });

  it("reads leaving as no call", () => {
    expect(callFromPresence(frame({ inCall: false }))).toBeNull();
    expect(callFromPresence(frame({ inCall: false, roomCode: ROOM }))).toBeNull();
    expect(callFromPresence(frame({ inCall: false, voiceRoomCode: ROOM, voiceChannel: "lounge01" }))).toBeNull();
  });

  it.each([
    ["a malformed channel id", { inCall: true, voiceRoomCode: ROOM, voiceChannel: "LOUNGE01" }],
    ["a too-short channel id", { inCall: true, voiceRoomCode: ROOM, voiceChannel: "abc" }],
    ["a non-string channel id", { inCall: true, voiceRoomCode: ROOM, voiceChannel: 12345678 }],
    ["the default channel spelled out", { inCall: true, voiceRoomCode: ROOM, voiceChannel: "" }],
    ["a channel with no room", { inCall: true, voiceChannel: "lounge01" }],
    ["a channel naming its room both ways", { inCall: true, roomCode: ROOM, voiceRoomCode: ROOM, voiceChannel: "lounge01" }],
    ["a room in the channel field's place with no channel", { inCall: true, voiceRoomCode: ROOM }],
    ["a channel in a DM", { inCall: true, voiceRoomCode: "dm-abc", voiceChannel: "lounge01" }],
    ["a non-string room", { inCall: true, roomCode: 7 }],
    ["an empty room", { inCall: true, roomCode: "" }],
    ["inCall that is not true", { inCall: "yes", roomCode: ROOM }],
  ])("refuses %s", (_what, fields) => {
    expect(callFromPresence(frame(fields))).toBeNull();
  });

  it("refuses what is not a frame at all", () => {
    expect(callFromPresence(null)).toBeNull();
    expect(callFromPresence("call")).toBeNull();
  });
});

describe("rosters", () => {
  const rooms = new Map([
    ["alice", ROOM],
    ["bob", ROOM],
    ["carol", ROOM],
    ["dave", "rd2_other"],
  ]);
  // alice has no channel entry at all: an entry kept before channels existed
  // is the default channel.
  const channels = new Map([
    ["bob", "lounge01"],
    ["carol", ""],
    ["dave", ""],
  ]);

  it("puts in one call only the peers of that room AND that channel", () => {
    expect(peersInCall(rooms, channels, { roomCode: ROOM, voiceChannel: "" })).toEqual(["alice", "carol"]);
    expect(peersInCall(rooms, channels, { roomCode: ROOM, voiceChannel: "lounge01" })).toEqual(["bob"]);
    expect(peersInCall(rooms, channels, { roomCode: ROOM, voiceChannel: "gaming01" })).toEqual([]);
    expect(peersInCall(rooms, channels, { roomCode: "rd2_other", voiceChannel: "" })).toEqual(["dave"]);
  });

  it("groups a room by channel, the default one always there", () => {
    expect(voiceChannelRoster(rooms, channels, ROOM)).toEqual(
      new Map([["", ["alice", "carol"]], ["lounge01", ["bob"]]]),
    );
    expect(voiceChannelRoster(new Map(), new Map(), ROOM)).toEqual(new Map([["", []]]));
  });

  it("adds us to our own channel, and only in our own room", () => {
    const self = { peerId: "me", call: { roomCode: ROOM, voiceChannel: "gaming01" } };
    expect(voiceChannelRoster(rooms, channels, ROOM, self).get("gaming01")).toEqual(["me"]);
    expect([...voiceChannelRoster(rooms, channels, "rd2_other", self).values()].flat()).not.toContain("me");
    expect([...voiceChannelRoster(rooms, channels, ROOM, { peerId: "me", call: null }).values()].flat()).not.toContain("me");
  });
});
