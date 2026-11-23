import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHANNEL_ID,
  UNLISTED_VOICE_NAME,
  buildTextChannels,
  buildVoiceChannels,
  channelDropOrder,
  channelMoveOrder,
  draggableChannelIds,
  orderedChannelIds,
  onScreenRoomUnread,
  roomHasChannelsToPick,
  roomsWithCalls,
  type SidebarVoicePerson,
  type VoiceOccupant,
} from "./sidebar-channels";
import type { RoomNotifyMode } from "./channel-ui";

const names: Record<string, string> = { me: "Alice", pBob: "Bob", pCarol: "Carol", pDan: "Dan" };
const person = (m: VoiceOccupant): SidebarVoicePerson => ({
  peerId: m.peerId,
  name: names[m.peerId] ?? m.peerId,
  avatarUrl: null,
  speaking: m.peerId === "pCarol",
  muted: m.peerId === "pBob",
});
const follow = (mode: RoomNotifyMode = "all") => () => ({ mode, own: null });

describe("the text section", () => {
  it("lists the room's channels in order with their unread counts", () => {
    const text = buildTextChannels(
      [
        { id: "", name: "general" },
        { id: "aaaaaaaaaaaaaaaa", name: "random" },
      ],
      (id) => (id === "" ? 2 : 5),
      follow()
    );
    expect(text.map((c) => [c.id, c.name, c.unread, c.muted])).toEqual([
      ["", "general", 2, false],
      ["aaaaaaaaaaaaaaaa", "random", 5, false],
    ]);
  });

  it("draws a channel muted when its mode, its own or its room's, is muted", () => {
    const text = buildTextChannels(
      [
        { id: "", name: "general" },
        { id: "aaaaaaaaaaaaaaaa", name: "random" },
        { id: "bbbbbbbbbbbbbbbb", name: "loud" },
      ],
      () => 0,
      (id) =>
        id === "bbbbbbbbbbbbbbbb"
          ? { mode: "all" as const, own: "all" as const }
          : { mode: "muted" as const, own: null }
    );
    expect(text.map((c) => c.muted)).toEqual([true, true, false]);
    expect(text[2]).toMatchObject({ notifyMode: "all", notifyOwn: "all" });
  });

  it("never draws the original chat muted in a room with nothing else, as before channels", () => {
    const [general] = buildTextChannels([{ id: "", name: "general" }], () => 3, follow("muted"));
    expect(general).toMatchObject({ id: DEFAULT_CHANNEL_ID, unread: 3, muted: false, notifyMode: "muted" });
  });
});

describe("the voice section", () => {
  const list = [
    { id: "", name: "voice" },
    { id: "cccccccccccccccc", name: "gaming" },
  ];

  it("lists every channel, empty ones included, with you first and the others by name", () => {
    const voice = buildVoiceChannels(
      list,
      new Map([
        ["", []],
        [
          "cccccccccccccccc",
          [
            { peerId: "pCarol", self: false },
            { peerId: "me", self: true },
            { peerId: "pBob", self: false },
          ],
        ],
      ]),
      "cccccccccccccccc",
      person
    );
    expect(voice.map((c) => [c.id, c.joined, c.people.map((p) => p.name)])).toEqual([
      ["", false, []],
      ["cccccccccccccccc", true, ["Alice", "Bob", "Carol"]],
    ]);
    expect(voice[1].people[1]).toMatchObject({ muted: true, speaking: false });
    expect(voice[1].people[2]).toMatchObject({ muted: false, speaking: true });
  });

  it("keeps the original call's people with it wherever it was moved to", () => {
    const voice = buildVoiceChannels(
      [...list].reverse(),
      new Map([["", [{ peerId: "pDan", self: false }]]]),
      "",
      person
    );
    expect(voice.map((c) => [c.id, c.joined, c.people.length])).toEqual([
      ["cccccccccccccccc", false, 0],
      ["", true, 1],
    ]);
  });

  it("is joined only in the channel you are in, and nowhere when you are in no call here", () => {
    const occupancy = new Map<string, VoiceOccupant[]>([["", [{ peerId: "pDan", self: false }]]]);
    expect(buildVoiceChannels(list, occupancy, null, person).map((c) => c.joined)).toEqual([false, false]);
    expect(buildVoiceChannels(list, occupancy, "", person).map((c) => c.joined)).toEqual([true, false]);
  });

  it("lists a call in a channel the list does not hold, after the others, so nobody is hidden", () => {
    const voice = buildVoiceChannels(
      [{ id: "", name: "voice" }],
      new Map([
        ["", []],
        ["dddddddddddddddd", [{ peerId: "pDan", self: false }]],
      ]),
      null,
      person
    );
    expect(voice.map((c) => [c.id, c.name])).toEqual([
      ["", "voice"],
      ["dddddddddddddddd", UNLISTED_VOICE_NAME],
    ]);
    // It has no place in the order: the original is alone there, and stays.
    expect(orderedChannelIds(voice)).toEqual([""]);
  });
});

describe("the rail tile of the room on screen", () => {
  it("counts the room's other channels, not the one being read", () => {
    const text = [
      { id: "", unread: 4 },
      { id: "a", unread: 2 },
      { id: "b", unread: 1 },
    ];
    expect(onScreenRoomUnread(text, "")).toBe(3);
    expect(onScreenRoomUnread(text, "a")).toBe(5);
  });

  it("is 0 in a room with only its original chat, as before", () => {
    expect(onScreenRoomUnread([{ id: "", unread: 7 }], "")).toBe(0);
  });
});

describe("a room tap on a phone", () => {
  it("keeps the drawer open only when there is a channel beyond the originals", () => {
    expect(roomHasChannelsToPick([{ id: "" }], [{ id: "" }])).toBe(false);
    expect(roomHasChannelsToPick([{ id: "" }, { id: "a" }], [{ id: "" }])).toBe(true);
    expect(roomHasChannelsToPick([{ id: "" }], [{ id: "" }, { id: "v" }])).toBe(true);
  });
});

describe("moving a channel a step", () => {
  const ids = ["", "a", "b", "c"];

  it("moves it among the others, the original in the order like any other", () => {
    expect(channelMoveOrder(ids, "b", -1)).toEqual(["", "b", "a", "c"]);
    expect(channelMoveOrder(ids, "b", 1)).toEqual(["", "a", "c", "b"]);
    expect(channelMoveOrder(ids, "", 1)).toEqual(["a", "", "b", "c"]);
    expect(channelMoveOrder(ids, "a", -1)).toEqual(["a", "", "b", "c"]);
    expect(channelMoveOrder(["a", ""], "", -1)).toEqual(["", "a"]);
  });

  it("goes nowhere past either end, alone, or for a channel not in the list", () => {
    expect(channelMoveOrder(ids, "", -1)).toBeNull();
    expect(channelMoveOrder(ids, "c", 1)).toBeNull();
    expect(channelMoveOrder(ids, "zz", 1)).toBeNull();
    expect(channelMoveOrder([""], "", 1)).toBeNull();
    expect(channelMoveOrder([""], "", -1)).toBeNull();
  });
});

describe("rooms with a call going on", () => {
  it("are the rooms anyone's presence names, plus your own call's", () => {
    const live = roomsWithCalls(new Map([["a", "r1"], ["b", "r1"], ["c", "r2"]]), "r3");
    expect([...live].sort()).toEqual(["r1", "r2", "r3"]);
    expect([...roomsWithCalls(new Map(), null)]).toEqual([]);
  });
});

describe("dragging a channel", () => {
  const ids = ["", "a", "b", "c"];

  it("lifts every channel, the original too, and none where there is only one", () => {
    expect(draggableChannelIds(ids)).toEqual(ids);
    expect(draggableChannelIds([""])).toEqual([]);
  });

  it("drops a channel at its new place, above the original too", () => {
    expect(channelDropOrder(ids, "a", 3)).toEqual(["", "b", "c", "a"]);
    expect(channelDropOrder(ids, "c", 0)).toEqual(["c", "", "a", "b"]);
    expect(channelDropOrder(ids, "", 2)).toEqual(["a", "b", "", "c"]);
    expect(channelDropOrder(ids, "b", 2)).toBeNull();
  });

  it("never lands past either end", () => {
    expect(channelDropOrder(ids, "b", -4)).toEqual(["b", "", "a", "c"]);
    expect(channelDropOrder(ids, "a", 9)).toEqual(["", "b", "c", "a"]);
  });

  it("does not move a lone channel or one the list does not hold", () => {
    expect(channelDropOrder([""], "", 1)).toBeNull();
    expect(channelDropOrder(ids, "zz", 0)).toBeNull();
    expect(channelDropOrder(ids, "a", 1.5)).toBeNull();
  });

  it("agrees with the keyboard's one-step move", () => {
    expect(channelDropOrder(ids, "b", 1)).toEqual(channelMoveOrder(ids, "b", -1));
    expect(channelDropOrder(ids, "b", 3)).toEqual(channelMoveOrder(ids, "b", 1));
    expect(channelDropOrder(ids, "", 1)).toEqual(channelMoveOrder(ids, "", 1));
  });
});
