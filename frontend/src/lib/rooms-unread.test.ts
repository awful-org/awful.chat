import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bulkPutMessages,
  putRoom,
  deleteMessagesForRoom,
  type DMRoom,
  type Room,
} from "./storage";
import { MessageType, type Message } from "./types/message";
import {
  noteRoomRead,
  noteUnreadArrivals,
  refreshUnreadCount,
  roomsStore,
} from "./rooms.svelte";

const ROOM = "room-unread-spec";
const DM = "dm-unread-spec";

function room(): Room {
  return {
    roomCode: ROOM,
    type: "text",
    name: "Room",
    lastSeenLamport: 0,
    createdAt: 1,
    participants: [],
    participantLastSeen: {},
  };
}

function dmRoom(): DMRoom {
  return {
    roomCode: DM,
    type: "dm",
    name: "",
    lastSeenLamport: 0,
    createdAt: 1,
    participants: ["did:key:them"],
    participantLastSeen: {},
    participantDid: "did:key:them",
  };
}

function msg(roomCode: string, lamport: number): Message {
  return {
    id: `${roomCode}-${lamport}`,
    roomCode,
    senderId: "did:key:them",
    senderName: "Them",
    timestamp: lamport,
    lamport,
    type: MessageType.Text,
    content: "hi",
    attachments: [],
  };
}

describe("refreshUnreadCount", () => {
  beforeEach(async () => {
    await deleteMessagesForRoom(ROOM);
    await deleteMessagesForRoom(DM);
    roomsStore.rooms = [];
    roomsStore.dmRooms = [];
    roomsStore.unreadCounts = new Map();
  });

  it("counts a room from its read watermark", async () => {
    await putRoom(room());
    roomsStore.rooms = [room()];
    await bulkPutMessages([msg(ROOM, 1), msg(ROOM, 2)]);
    await refreshUnreadCount(ROOM);
    expect(roomsStore.unreadCounts.get(ROOM)).toBe(2);
  });

  it("counts a room the sidebar mirror has not caught up to yet", async () => {
    // The record exists but the mirror is still empty, which is what a
    // deep-link join looks like while loadRooms is in flight.
    await putRoom(room());
    await bulkPutMessages([msg(ROOM, 1)]);
    await refreshUnreadCount(ROOM);
    expect(roomsStore.unreadCounts.get(ROOM)).toBe(1);
  });

  it("never files a DM conversation in the room counter", async () => {
    // DM records live in the same storage as rooms, so the mirror fallback
    // resolves one happily - and every consumer that sums this map also adds
    // the separate DM total, so a dm- entry here is counted twice. A DM file, a
    // DM plugin card and a DM history repair all arrive carrying a dm- code.
    await putRoom(dmRoom());
    roomsStore.dmRooms = [dmRoom()];
    await bulkPutMessages([msg(DM, 1), msg(DM, 2)]);

    await refreshUnreadCount(DM);

    expect(roomsStore.unreadCounts.has(DM)).toBe(false);
    expect([...roomsStore.unreadCounts.keys()].filter((k) => k.startsWith("dm-")))
      .toEqual([]);
  });
});

describe("unread counts kept as rows arrive", () => {
  beforeEach(async () => {
    await deleteMessagesForRoom(ROOM);
    roomsStore.rooms = [room()];
    roomsStore.dmRooms = [];
    roomsStore.unreadCounts = new Map();
    await putRoom(room());
  });

  /** Store rows, then tell the counter, as the transport does. */
  async function arrive(rows: Message[]): Promise<void> {
    await bulkPutMessages(rows);
    noteUnreadArrivals(ROOM, rows);
  }

  it("adds new messages without reading the unread backlog again", async () => {
    await bulkPutMessages(Array.from({ length: 500 }, (_, i) => msg(ROOM, i + 1)));
    await refreshUnreadCount(ROOM);
    expect(roomsStore.unreadCounts.get(ROOM)).toBe(500);
    const getAll = vi.spyOn(IDBIndex.prototype, "getAll");
    for (let l = 501; l <= 520; l++) await arrive([msg(ROOM, l)]);
    expect(roomsStore.unreadCounts.get(ROOM)).toBe(520);
    expect(getAll).not.toHaveBeenCalled();
    getAll.mockRestore();
  });

  it("counts what does not count as unread as nothing", async () => {
    await refreshUnreadCount(ROOM);
    await arrive([
      { ...msg(ROOM, 1), type: MessageType.Reaction },
      { ...msg(ROOM, 2), type: MessageType.PluginUpdate },
    ]);
    expect(roomsStore.unreadCounts.get(ROOM)).toBe(0);
  });

  it("counts a message delivered twice once", async () => {
    await refreshUnreadCount(ROOM);
    const m = msg(ROOM, 1);
    await arrive([m]);
    noteUnreadArrivals(ROOM, [m]);
    expect(roomsStore.unreadCounts.get(ROOM)).toBe(1);
  });

  it("counts from storage again once the room was read", async () => {
    await refreshUnreadCount(ROOM);
    await arrive([msg(ROOM, 1), msg(ROOM, 2)]);
    // Read up to lamport 1 - row 2 never reached the screen.
    roomsStore.rooms = [{ ...room(), lastSeenLamport: 1 }];
    noteRoomRead(ROOM);
    expect(roomsStore.unreadCounts.get(ROOM)).toBe(0);
    await arrive([msg(ROOM, 3)]);
    await vi.waitFor(() => expect(roomsStore.unreadCounts.get(ROOM)).toBe(2));
  });

  it("recounts a room once, however many arrivals ask at the same time", async () => {
    await bulkPutMessages([msg(ROOM, 1)]);
    const getAll = vi.spyOn(IDBIndex.prototype, "getAll");
    await Promise.all([refreshUnreadCount(ROOM), refreshUnreadCount(ROOM), refreshUnreadCount(ROOM)]);
    expect(roomsStore.unreadCounts.get(ROOM)).toBe(1);
    // The one in flight, plus ONE more pass for the two calls that came
    // during it - not three reads.
    const reads = getAll.mock.calls.length;
    getAll.mockClear();
    await refreshUnreadCount(ROOM);
    expect(reads).toBe(2 * getAll.mock.calls.length);
    getAll.mockRestore();
  });

  it("leaves the map alone when a recount changes nothing", async () => {
    await bulkPutMessages([msg(ROOM, 1)]);
    await refreshUnreadCount(ROOM);
    const before = roomsStore.unreadCounts;
    await refreshUnreadCount(ROOM);
    expect(roomsStore.unreadCounts).toBe(before);
  });
});
