import { beforeEach, describe, expect, it } from "vitest";
import {
  bulkPutMessages,
  deleteMessagesForRoom,
  deleteRoom,
  getRoom,
  markRoomSeen,
  putRoom,
  type Room,
} from "./storage";
import { MessageType, type Message } from "./types/message";
import {
  channelUnreadCount,
  noteRoomChannels,
  noteRoomRead,
  noteUnreadArrivals,
  pinnedMessagesOf,
  refreshUnreadCount,
  roomChannel,
  roomChannels,
  roomsStore,
  toggleMessagePin,
} from "./rooms.svelte";
import { forgetCurrentChannel, setCurrentChannel } from "./channel-view.svelte";
import type { Channel } from "./channels";

// Unread counts and pins per channel, over the real storage module.

const ROOM = "room-channels-spec";
const GAMES = "gamesgames";
const MUSIC = "musicmusic";
const NEW = "newnewnew0";

const STAMP = Date.now() - 1000;
const list: Channel[] = [
  { id: GAMES, kind: "text", name: "games", position: 1, updatedAt: STAMP },
  { id: MUSIC, kind: "text", name: "music", position: 2, updatedAt: STAMP, deleted: true },
];

function room(over: Partial<Room> = {}): Room {
  return {
    roomCode: ROOM, type: "text", name: "Room", lastSeenLamport: 0, createdAt: 1,
    participants: [], participantLastSeen: {}, channels: list, ...over,
  };
}

function msg(lamport: number, channel?: string, over: Partial<Message> = {}): Message {
  return {
    id: `${ROOM}-${lamport}`, roomCode: ROOM, senderId: "did:key:them", senderName: "Them",
    timestamp: lamport, lamport, type: MessageType.Text, content: "hi", attachments: [],
    ...(channel ? { channel } : {}), ...over,
  };
}

/** What markSeen does for a channel: the stored mark, then the mirror, then the count. */
async function read(channel: string, lamport: number): Promise<void> {
  await markRoomSeen(ROOM, lamport, undefined, channel);
  const stored = (await getRoom(ROOM))!;
  roomsStore.rooms = roomsStore.rooms.map((r) => (r.roomCode === ROOM ? stored : r));
  noteRoomRead(ROOM, channel);
}

beforeEach(async () => {
  await deleteMessagesForRoom(ROOM);
  await deleteRoom(ROOM);
  roomsStore.rooms = [];
  roomsStore.unreadCounts = new Map();
  roomsStore.channelUnread = new Map();
  forgetCurrentChannel();
});

describe("unread per channel", () => {
  it("counts every live channel against its own mark; the room total is their sum", async () => {
    await putRoom(room());
    roomsStore.rooms = [room()];
    await bulkPutMessages([msg(1), msg(2), msg(3, GAMES), msg(4, GAMES), msg(5, MUSIC), msg(6, NEW)]);
    await refreshUnreadCount(ROOM);
    // MUSIC is deleted and NEW is not in the list yet: nothing could show
    // their messages, so nothing counts them.
    expect(channelUnreadCount(ROOM, "")).toBe(2);
    expect(channelUnreadCount(ROOM, GAMES)).toBe(2);
    expect(channelUnreadCount(ROOM, MUSIC)).toBe(0);
    expect(roomsStore.unreadCounts.get(ROOM)).toBe(4);
  });

  it("reading one channel leaves the others' counts", async () => {
    await putRoom(room());
    roomsStore.rooms = [room()];
    await bulkPutMessages([msg(1), msg(2, GAMES), msg(3, GAMES)]);
    await refreshUnreadCount(ROOM);
    await read(GAMES, 3);
    expect(channelUnreadCount(ROOM, GAMES)).toBe(0);
    expect(channelUnreadCount(ROOM, "")).toBe(1);
    expect(roomsStore.unreadCounts.get(ROOM)).toBe(1);
    // The next arrival recounts from storage, which has the channel's mark.
    await bulkPutMessages([msg(4, GAMES)]);
    noteUnreadArrivals(ROOM, [msg(4, GAMES)]);
    await refreshUnreadCount(ROOM);
    expect(channelUnreadCount(ROOM, GAMES)).toBe(1);
    expect(channelUnreadCount(ROOM, "")).toBe(1);
    expect(roomsStore.unreadCounts.get(ROOM)).toBe(2);
  });

  it("adds arrivals to their own channel without reading the room again", async () => {
    await putRoom(room({ channelSeen: { [GAMES]: 10 } }));
    roomsStore.rooms = [room({ channelSeen: { [GAMES]: 10 } })];
    await refreshUnreadCount(ROOM);
    noteUnreadArrivals(ROOM, [msg(5, GAMES), msg(11, GAMES), msg(12), msg(13, MUSIC), msg(14, NEW)]);
    // 5 is below the channel's mark; MUSIC and NEW are in no count.
    expect(channelUnreadCount(ROOM, GAMES)).toBe(1);
    expect(channelUnreadCount(ROOM, "")).toBe(1);
    expect(roomsStore.unreadCounts.get(ROOM)).toBe(2);
  });

  it("counts a channel once its list arrives", async () => {
    await putRoom(room());
    roomsStore.rooms = [room()];
    await bulkPutMessages([msg(1, NEW), msg(2, NEW)]);
    await refreshUnreadCount(ROOM);
    expect(roomsStore.unreadCounts.get(ROOM)).toBe(0);
    const withNew: Channel[] = [...list, { id: NEW, kind: "text", name: "new", position: 3, updatedAt: STAMP }];
    await putRoom(room({ channels: withNew }));
    noteRoomChannels(ROOM, withNew);
    await refreshUnreadCount(ROOM);
    expect(channelUnreadCount(ROOM, NEW)).toBe(2);
    expect(roomsStore.unreadCounts.get(ROOM)).toBe(2);
  });

  it("in a room without channels, counts and reads exactly as before", async () => {
    await putRoom(room({ channels: undefined }));
    roomsStore.rooms = [room({ channels: undefined })];
    await bulkPutMessages([msg(1), msg(2)]);
    await refreshUnreadCount(ROOM);
    expect(roomsStore.unreadCounts.get(ROOM)).toBe(2);
    await read("", 2);
    expect(roomsStore.unreadCounts.get(ROOM)).toBe(0);
  });
});

describe("channels and pins of a room", () => {
  it("lists the live channels, the original first", async () => {
    roomsStore.rooms = [room()];
    expect(roomChannels(ROOM, "text").map((c) => c.name)).toEqual(["general", "games"]);
    expect(roomChannel(ROOM, MUSIC)).toBeUndefined();
    expect(roomChannel(ROOM, "")?.name).toBe("general");
  });

  it("lists the original where it was moved to, and counts its unread the same", async () => {
    const moved: Channel[] = [
      { id: "", kind: "text", name: "lobby", position: 9, updatedAt: STAMP },
      ...room().channels!,
    ];
    await putRoom(room({ channels: moved }));
    roomsStore.rooms = [room({ channels: moved })];
    expect(roomChannels(ROOM, "text").map((c) => c.name)).toEqual(["games", "lobby"]);
    expect(roomChannel(ROOM, "")?.name).toBe("lobby");
    await bulkPutMessages([msg(1), msg(2)]);
    await refreshUnreadCount(ROOM);
    expect(channelUnreadCount(ROOM, "")).toBe(2);
  });

  it("files a pin under the channel open in the room", async () => {
    await putRoom(room());
    roomsStore.rooms = [room()];
    await toggleMessagePin(ROOM, "in-general");
    setCurrentChannel(ROOM, GAMES);
    await toggleMessagePin(ROOM, "in-games");
    expect(pinnedMessagesOf(ROOM)).toEqual(["in-games"]);
    expect(pinnedMessagesOf(ROOM, "")).toEqual(["in-general"]);
    const stored = await getRoom(ROOM);
    expect(stored?.pinnedMessages).toEqual(["in-general"]);
    expect(stored?.channelPins).toEqual({ [GAMES]: ["in-games"] });
    await toggleMessagePin(ROOM, "in-games");
    expect(pinnedMessagesOf(ROOM)).toEqual([]);
  });
});
