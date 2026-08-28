import { beforeEach, describe, expect, it } from "vitest";
import {
  bulkPutMessages,
  putRoom,
  deleteMessagesForRoom,
  type DMRoom,
  type Room,
} from "./storage";
import { MessageType, type Message } from "./types/message";
import { refreshUnreadCount, roomsStore } from "./rooms.svelte";

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
