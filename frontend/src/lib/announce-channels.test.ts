import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageType, type Message } from "./types/message";

// Notifications for a message in a channel (channels.ts): named after it,
// as loud as that channel is allowed to be, and "being read" only when that
// very channel is on screen.

const notified: Array<{
  title: string;
  body: string;
  viewingConversation?: boolean;
  data?: { roomCode: string; channel?: string };
}> = [];
const GAMES = "gamesgames";
const GONE = "gonegone00";

vi.mock("./blocks.svelte", () => ({ isBlockedDid: () => false }));
vi.mock("./notify.svelte", () => ({
  notifyMessage: (opts: (typeof notified)[number]) => notified.push(opts),
  closeNotificationsByTag: () => {},
}));
vi.mock("./plugins/registry", () => ({ getManifest: () => undefined }));
vi.mock("./rooms.svelte", () => ({
  roomsStore: {
    rooms: [{
      roomCode: "room-a",
      name: "The Room",
      channels: [
        { id: "gamesgames", kind: "text", name: "games", position: 1, updatedAt: 1 },
        { id: "gonegone00", kind: "text", name: "gone", position: 2, updatedAt: 2, deleted: true },
      ],
    }],
    dmRooms: [],
  },
}));
vi.mock("./notify-intents", async (orig) => ({
  ...(await orig<typeof import("./notify-intents")>()),
  rememberRoomRef: () => Promise.resolve(),
}));

const { announceMessage, _resetAnnounced } = await import("./announce");
const {
  setRoomNotifyMode,
  getRoomNotifyMode,
  setChannelNotifyMode,
  effectiveNotifyMode,
  getChannelNotifyMode,
  roomNotifySetting,
} = await import("./notify-prefs.svelte");

const ME = "did:key:me";
const ctx = {
  selfIds: [ME],
  uiRoomCode: null as string | null,
  uiChannel: "" as string,
  resolveName: () => "Me",
};

let n = 0;
function msg(over: Partial<Message> = {}): Message {
  n += 1;
  return {
    id: `m${n}`, roomCode: "room-a", senderId: "did:key:them", senderName: "Them",
    timestamp: 1, lamport: 1, type: MessageType.Text, content: "hello", attachments: [], ...over,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  notified.length = 0;
  ctx.uiRoomCode = null;
  ctx.uiChannel = "";
  _resetAnnounced();
  setRoomNotifyMode("room-a", "all");
  setChannelNotifyMode("room-a", GAMES, null);
  setChannelNotifyMode("room-a", "", null);
});
afterEach(() => vi.useRealTimers());

/** Let the burst window close between messages, so each is its own. */
function announce(m: Message): void {
  announceMessage(m, ctx);
  vi.advanceTimersByTime(2500);
}

describe("a message in a channel", () => {
  it("is titled with the room and the channel", () => {
    announce(msg({ channel: GAMES }));
    expect(notified.map((x) => x.title)).toEqual(["The Room #games"]);
    announce(msg({ channel: GAMES, content: `hey @[${ME}]` }));
    expect(notified[1].title).toBe("Them mentioned you in #games");
    // The original chat is titled as it always was.
    announce(msg());
    expect(notified[2].title).toBe("The Room");
  });

  it("says nothing for a channel that is deleted or not in the list", () => {
    announce(msg({ channel: GONE }));
    announce(msg({ channel: "unknown000" }));
    expect(notified).toEqual([]);
  });

  it("follows its own mode when one was picked, the room's otherwise", () => {
    setChannelNotifyMode("room-a", GAMES, "muted");
    announce(msg({ channel: GAMES }));
    expect(notified).toHaveLength(0);
    announce(msg());
    expect(notified).toHaveLength(1);

    // One loud channel in a muted room.
    setRoomNotifyMode("room-a", "muted");
    setChannelNotifyMode("room-a", GAMES, "all");
    announce(msg({ channel: GAMES }));
    announce(msg());
    expect(notified).toHaveLength(2);

    setChannelNotifyMode("room-a", GAMES, null);
    expect(getChannelNotifyMode("room-a", GAMES)).toBeNull();
    expect(effectiveNotifyMode("room-a", GAMES)).toBe("muted");
    // The original chat follows the room until it is given a mode of its own.
    expect(getChannelNotifyMode("room-a", "")).toBeNull();
  });

  it("goes quiet in every channel when the room is muted after a channel was made loud", () => {
    // Muting a room from its menu is "no sound from this room": a channel
    // that kept "all messages" from before must not go on beeping.
    setRoomNotifyMode("room-a", "mentions");
    setChannelNotifyMode("room-a", GAMES, "all");
    announce(msg({ channel: GAMES }));
    expect(notified).toHaveLength(1);

    setRoomNotifyMode("room-a", "muted", ["", GAMES]);
    expect(getChannelNotifyMode("room-a", GAMES)).toBeNull();
    announce(msg({ channel: GAMES }));
    announce(msg({ channel: GAMES, content: `hey @[${ME}]` }));
    announce(msg());
    expect(notified).toHaveLength(1);

    // A channel muted on its own stays muted when the room comes back.
    setChannelNotifyMode("room-a", GAMES, "muted");
    setRoomNotifyMode("room-a", "muted", [GAMES]);
    setRoomNotifyMode("room-a", "all", [GAMES]);
    expect(getChannelNotifyMode("room-a", GAMES)).toBe("muted");
    // Turning the room up leaves the channels' own choices alone.
    setChannelNotifyMode("room-a", GAMES, "mentions");
    setRoomNotifyMode("room-a", "all", [GAMES]);
    expect(getChannelNotifyMode("room-a", GAMES)).toBe("mentions");
  });

  it("mutes the original chat alone, and the room with it or without it", () => {
    setChannelNotifyMode("room-a", "", "muted");
    expect(getRoomNotifyMode("room-a")).toBe("all");
    announce(msg());
    announce(msg({ content: `hey @[${ME}]` }));
    expect(notified).toHaveLength(0);
    announce(msg({ channel: GAMES }));
    expect(notified).toHaveLength(1);

    // The room muted before is a muted room, not a muted original chat.
    setChannelNotifyMode("room-a", "", null);
    setRoomNotifyMode("room-a", "muted");
    expect(getChannelNotifyMode("room-a", "")).toBeNull();
    expect(effectiveNotifyMode("room-a")).toBe("muted");
    announce(msg());
    expect(notified).toHaveLength(1);
    // Unmuted from its own menu after that, it is loud on its own.
    setChannelNotifyMode("room-a", "", "all");
    announce(msg());
    announce(msg({ channel: GAMES }));
    expect(notified).toHaveLength(2);
    // And muting the room again takes that back, as for any other channel.
    setRoomNotifyMode("room-a", "muted", ["", GAMES]);
    expect(getChannelNotifyMode("room-a", "")).toBeNull();
    announce(msg());
    expect(notified).toHaveLength(2);

    // Muted on its own, it stays so when the room comes back.
    setChannelNotifyMode("room-a", "", "muted");
    setRoomNotifyMode("room-a", "muted", ["", GAMES]);
    setRoomNotifyMode("room-a", "all", ["", GAMES]);
    expect(getChannelNotifyMode("room-a", "")).toBe("muted");
  });

  it("goes by mentions only in the original chat alone", () => {
    setChannelNotifyMode("room-a", "", "mentions");
    announce(msg());
    announce(msg({ channel: GAMES }));
    announce(msg({ content: `hey @[${ME}]` }));
    expect(notified.map((x) => x.title)).toEqual(["The Room #games", "Them mentioned you"]);
  });

  it("is one setting in a room with one chat", () => {
    // The chat was muted while there were others, and they are gone since.
    setChannelNotifyMode("room-a", "", "muted");
    expect(roomNotifySetting("room-a", ["", GAMES])).toBe("all");
    expect(roomNotifySetting("room-a", [""])).toBe("muted");
    // Turning the room up is turning the chat up: nothing of its own is left.
    setRoomNotifyMode("room-a", "all", [""]);
    expect(getChannelNotifyMode("room-a", "")).toBeNull();
    expect(roomNotifySetting("room-a", [""])).toBe("all");
    announce(msg());
    expect(notified).toHaveLength(1);
  });

  it("is nothing a DM has", () => {
    setRoomNotifyMode("dm-x", "mentions");
    setChannelNotifyMode("dm-x", "", "muted");
    expect(getChannelNotifyMode("dm-x", "")).toBeNull();
    expect(effectiveNotifyMode("dm-x")).toBe("mentions");
    expect(roomNotifySetting("dm-x", [])).toBe("mentions");
    setRoomNotifyMode("dm-x", "all");
  });

  it("drops what a burst was still holding when the original chat is muted, not another channel's", () => {
    announceMessage(msg(), ctx); // the first goes out at once
    announceMessage(msg(), ctx);
    announceMessage(msg({ channel: GAMES }), ctx);
    setChannelNotifyMode("room-a", "", "muted");
    vi.advanceTimersByTime(5000);
    expect(notified.map((x) => x.title)).toEqual(["The Room", "The Room #games"]);
  });

  it("drops what a burst was still holding when the room is muted", () => {
    announceMessage(msg(), ctx); // the first goes out at once
    announceMessage(msg(), ctx); // the next waits for the window
    expect(notified).toHaveLength(1);
    setRoomNotifyMode("room-a", "muted");
    vi.advanceTimersByTime(5000);
    expect(notified).toHaveLength(1);
  });

  it("makes no sound at all for a call starting in a muted room", () => {
    setRoomNotifyMode("room-a", "muted", [GAMES]);
    announce(
      msg({ type: MessageType.CallEvent, content: JSON.stringify({ v: 1, callId: "abcdefgh", phase: "start", at: 1 }) })
    );
    expect(notified).toHaveLength(0);
    setRoomNotifyMode("room-a", "all");
    announce(
      msg({ type: MessageType.CallEvent, content: JSON.stringify({ v: 1, callId: "bcdefghi", phase: "start", at: 1 }) })
    );
    expect(notified).toHaveLength(1);
  });

  it("tells a click and an inline reply which channel it is about", () => {
    // Without it the reply was sent into whichever channel the room was
    // last left on: a reply to a mention in #games landed in the original chat.
    announce(msg({ channel: GAMES }));
    announce(msg());
    expect(notified.map((x) => x.data?.channel)).toEqual([GAMES, ""]);
  });

  it("names no channel for a burst across channels of one room", () => {
    announceMessage(msg({ channel: GAMES }), ctx);
    announceMessage(msg({ channel: GAMES }), ctx);
    announceMessage(msg(), ctx);
    vi.advanceTimersByTime(2500);
    // The first goes out at once; the two behind it are one burst.
    expect(notified.map((x) => x.data?.channel)).toEqual([GAMES, undefined]);
    expect(notified[1].data).toHaveProperty("roomCode");
    expect(notified[1].data).not.toHaveProperty("channel");

    announceMessage(msg({ channel: GAMES }), ctx);
    announceMessage(msg({ channel: GAMES }), ctx);
    announceMessage(msg({ channel: GAMES }), ctx);
    vi.advanceTimersByTime(2500);
    // Still inside the window the burst opened: all three are one, of #games.
    expect(notified).toHaveLength(3);
    expect(notified[2].data?.channel).toBe(GAMES);
  });

  it("is being read only when its own channel is on screen", () => {
    ctx.uiRoomCode = "room-a";
    ctx.uiChannel = "";
    announce(msg({ channel: GAMES }));
    ctx.uiChannel = GAMES;
    announce(msg({ channel: GAMES }));
    expect(notified.map((x) => x.viewingConversation)).toEqual([false, true]);
  });
});
