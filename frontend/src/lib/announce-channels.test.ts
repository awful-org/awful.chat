import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageType, type Message } from "./types/message";

// Notifications for a message in a channel (channels.ts): named after it,
// as loud as that channel is allowed to be, and "being read" only when that
// very channel is on screen.

const notified: Array<{ title: string; body: string; viewingConversation?: boolean }> = [];
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
const { setRoomNotifyMode, setChannelNotifyMode, effectiveNotifyMode, getChannelNotifyMode } =
  await import("./notify-prefs.svelte");

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
    // The original chat has no mode apart from the room's.
    expect(getChannelNotifyMode("room-a", "")).toBeNull();
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
