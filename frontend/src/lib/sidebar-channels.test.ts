import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHANNEL_ID,
  defaultTextChannels,
  defaultVoiceChannels,
  roomsWithCalls,
  type CallRoster,
} from "./sidebar-channels";

const names: Record<string, string> = { pBob: "Bob", pCarol: "Carol", pDan: "Dan" };

function roster(over: Partial<CallRoster> = {}, self: Partial<CallRoster["self"]> = {}): CallRoster {
  return {
    callPeerRooms: new Map([
      ["pCarol", "room1"],
      ["pBob", "room1"],
      ["pDan", "room2"],
    ]),
    callPeerStates: new Map([["pBob", { muted: true }]]),
    speaking: new Set(["pCarol"]),
    describe: (peerId) => ({ name: names[peerId] ?? peerId, avatarUrl: null }),
    ...over,
    self: {
      id: "did:me",
      peerId: "pMe",
      inCall: false,
      callRoomCode: null,
      muted: false,
      name: "Alice",
      ...self,
    },
  };
}

describe("the stand-in text channel", () => {
  it("is the room's chat, carrying the room's unread count", () => {
    expect(defaultTextChannels(4)).toEqual([
      { id: DEFAULT_CHANNEL_ID, name: "general", unread: 4, muted: false },
    ]);
  });
});

describe("the stand-in voice channel", () => {
  it("lists who is in this room's call, by name, with their speaking and mute state", () => {
    const [voice] = defaultVoiceChannels("room1", roster());
    expect(voice.id).toBe(DEFAULT_CHANNEL_ID);
    expect(voice.joined).toBe(false);
    expect(voice.people).toEqual([
      { peerId: "pBob", name: "Bob", avatarUrl: null, speaking: false, muted: true },
      { peerId: "pCarol", name: "Carol", avatarUrl: null, speaking: true, muted: false },
    ]);
  });

  it("puts you first and marks it joined when you are in it", () => {
    const [voice] = defaultVoiceChannels(
      "room1",
      roster({ speaking: new Set(["did:me"]) }, { inCall: true, callRoomCode: "room1", muted: true })
    );
    expect(voice.joined).toBe(true);
    expect(voice.people[0]).toEqual({
      peerId: "did:me",
      name: "Alice",
      avatarUrl: null,
      speaking: true,
      muted: true,
    });
    expect(voice.people.map((p) => p.name)).toEqual(["Alice", "Bob", "Carol"]);
  });

  it("does not list you twice when the roster echoes your own presence", () => {
    const rooms = new Map([["pMe", "room1"]]);
    const [voice] = defaultVoiceChannels(
      "room1",
      roster({ callPeerRooms: rooms }, { inCall: true, callRoomCode: "room1" })
    );
    expect(voice.people.map((p) => p.name)).toEqual(["Alice"]);
  });

  it("is not joined, and does not list you, while your call is in another room", () => {
    const [voice] = defaultVoiceChannels("room2", roster({}, { inCall: true, callRoomCode: "room1" }));
    expect(voice.joined).toBe(false);
    expect(voice.people.map((p) => p.name)).toEqual(["Dan"]);
  });

  it("is empty with nobody in the call", () => {
    const [voice] = defaultVoiceChannels("room3", roster());
    expect(voice.people).toEqual([]);
  });
});

describe("rooms with a call going on", () => {
  it("are the rooms anyone's presence names, plus your own call's", () => {
    const live = roomsWithCalls(new Map([["a", "r1"], ["b", "r1"], ["c", "r2"]]), "r3");
    expect([...live].sort()).toEqual(["r1", "r2", "r3"]);
    expect([...roomsWithCalls(new Map(), null)]).toEqual([]);
  });
});
