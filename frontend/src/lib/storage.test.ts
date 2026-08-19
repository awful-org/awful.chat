import { beforeEach, describe, expect, it } from "vitest";
import {
  bulkPutMessages,
  getMessage,
  getMessages,
  getUnreadCount,
  getWatermark,
  getWatermarksForRoom,
  markRoomSeen,
  putMessage,
  putRoom,
  getRoom,
  setWatermark,
  updateMessageStatus,
  wipeLocalDatabase,
  type Room,
  nextDmLamport,
  dedupePhonebook,
  putPhonebookEntry,
  getPhonebookEntries,
  markOwnMessagesReadUpTo,
  getOwnProfile,
  putOwnProfile,
  updateOwnProfile,
  getAllMessages,
} from "./storage";
import { MessageType, type Message } from "./types/message";

let seq = 0;
function msg(overrides: Partial<Message> = {}): Message {
  seq += 1;
  return {
    id: `msg-${seq}`,
    roomCode: "room-a",
    senderId: "alice",
    senderName: "Alice",
    timestamp: 1000 + seq,
    lamport: seq,
    type: MessageType.Text,
    content: `message ${seq}`,
    attachments: [],
    ...overrides,
  };
}

beforeEach(async () => {
  await wipeLocalDatabase();
  seq = 0;
});

describe("watermarks", () => {
  it("stores and reads per-sender max lamport", async () => {
    await setWatermark("room-a", "alice", 5);
    expect(await getWatermark("room-a", "alice")).toBe(5);
  });

  it("never regresses", async () => {
    await setWatermark("room-a", "alice", 10);
    await setWatermark("room-a", "alice", 3);
    expect(await getWatermark("room-a", "alice")).toBe(10);
  });

  it("collects all senders for a room", async () => {
    await setWatermark("room-a", "alice", 4);
    await setWatermark("room-a", "bob", 9);
    await setWatermark("room-b", "carol", 1);
    expect(await getWatermarksForRoom("room-a")).toEqual({
      alice: 4,
      bob: 9,
    });
  });
});

describe("message status", () => {
  it("advances forward", async () => {
    const m = msg({ status: "sending" });
    await putMessage(m);
    await updateMessageStatus(m.id, "delivered");
    expect((await getMessage(m.id))?.status).toBe("delivered");
  });

  it("never regresses (late delivered ack after read)", async () => {
    const m = msg({ status: "read" });
    await putMessage(m);
    await updateMessageStatus(m.id, "delivered");
    expect((await getMessage(m.id))?.status).toBe("read");
  });

  it("ignores unknown message ids", async () => {
    await expect(
      updateMessageStatus("nope", "delivered")
    ).resolves.toBeUndefined();
  });
});

describe("unread counts and seen tracking", () => {
  const room: Room = {
    roomCode: "room-a",
    type: "text",
    name: "Room A",
    lastSeenLamport: 0,
    createdAt: 0,
    participants: [],
  };

  it("counts messages past the seen watermark", async () => {
    await putRoom(room);
    await bulkPutMessages([msg(), msg(), msg()]); // lamports 1..3
    expect(await getUnreadCount("room-a", 0)).toBe(3);
    expect(await getUnreadCount("room-a", 2)).toBe(1);
  });

  it("excludes own messages when asked", async () => {
    await putRoom(room);
    await bulkPutMessages([
      msg({ senderId: "me" }),
      msg({ senderId: "alice" }),
    ]);
    expect(await getUnreadCount("room-a", 0, "me")).toBe(1);
  });

  it("markRoomSeen persists the watermark", async () => {
    await putRoom(room);
    await markRoomSeen("room-a", 42);
    expect((await getRoom("room-a"))?.lastSeenLamport).toBe(42);
  });

  it("markRoomSeen never moves the watermark backwards", async () => {
    await putRoom(room);
    await markRoomSeen("room-a", 42);
    await markRoomSeen("room-a", 7);
    expect((await getRoom("room-a"))?.lastSeenLamport).toBe(42);
  });
});

describe("message pagination", () => {
  it("pages by lamport descending window, returned ascending", async () => {
    await bulkPutMessages(
      Array.from({ length: 60 }, () => msg())
    );
    const page = await getMessages("room-a");
    expect(page).toHaveLength(50);
    expect(page[0].lamport).toBe(11);
    expect(page[49].lamport).toBe(60);

    const older = await getMessages("room-a", 11);
    expect(older).toHaveLength(10);
    expect(older[older.length - 1].lamport).toBe(10);
  });
});

describe("nextDmLamport", () => {
  it("uses the wall clock when it is ahead of the room", async () => {
    expect(await nextDmLamport("dm-clock-a", 5_000)).toBe(5_000);
  });

  it("floors to last-issued + 1 when the clock runs behind", async () => {
    const first = await nextDmLamport("dm-clock-b", 9_000);
    const second = await nextDmLamport("dm-clock-b", 1_000);
    expect(first).toBe(9_000);
    expect(second).toBe(9_001);
  });

  it("floors to the stored room maximum", async () => {
    await bulkPutMessages([
      msg({ id: "dm-m1", roomCode: "dm-clock-c", lamport: 7_777 }),
    ]);
    expect(await nextDmLamport("dm-clock-c", 100)).toBe(7_778);
  });
});

describe("dedupePhonebook", () => {
  it("merges duplicate contacts sharing a did and keeps the best fields", async () => {
    await putPhonebookEntry({
      peerId: "did:key:zDup",
      nickname: "Old Name",
      addedAt: 1_000,
      favorite: true,
    });
    await putPhonebookEntry({
      peerId: "12D3KooWDupPeer",
      did: "did:key:zDup",
      nickname: "New Name",
      addedAt: 2_000,
    });
    await putPhonebookEntry({
      peerId: "12D3KooWLoner",
      nickname: "No Did",
      addedAt: 3_000,
    });
    await dedupePhonebook();
    const entries = await getPhonebookEntries();
    const dupes = entries.filter(
      (e) => e.did === "did:key:zDup" || e.peerId === "did:key:zDup"
    );
    expect(dupes).toHaveLength(1);
    expect(dupes[0].peerId).toBe("12D3KooWDupPeer");
    expect(dupes[0].favorite).toBe(true);
    expect(dupes[0].addedAt).toBe(1_000);
    expect(entries.some((e) => e.peerId === "12D3KooWLoner")).toBe(true);
  });
});

describe("own profile color", () => {
  it("persists a selected nickname color", async () => {
    await putOwnProfile({
      did: "did:key:zMe",
      isMe: true,
      nickname: "Me",
      updatedAt: 1_000,
    });
    await updateOwnProfile({ color: "#ab12cd" });
    expect((await getOwnProfile())?.color).toBe("#ab12cd");
    expect((await getOwnProfile())?.nickname).toBe("Me");
  });

  it("clears an existing color", async () => {
    await putOwnProfile({
      did: "did:key:zMe",
      isMe: true,
      nickname: "Me",
      color: "#ab12cd",
      updatedAt: 1_000,
    });
    await updateOwnProfile({ color: undefined });
    expect((await getOwnProfile())?.color).toBeUndefined();
  });
});

describe("markOwnMessagesReadUpTo", () => {
  it("cascades read onto own older messages only, never touching the peer's", async () => {
    await bulkPutMessages([
      msg({ id: "own-1", senderId: "me", lamport: 10, status: "delivered" }),
      msg({ id: "own-2", senderId: "me", lamport: 20, status: "sent" }),
      msg({ id: "own-3", senderId: "me", lamport: 99, status: "sent" }),
      msg({ id: "theirs", senderId: "them", lamport: 15, status: "delivered" }),
    ]);
    const changed = await markOwnMessagesReadUpTo("room-a", "me", 20);
    expect([...changed].sort()).toEqual(["own-1", "own-2"]);
    expect((await getMessage("own-3"))?.status).toBe("sent");
    expect((await getMessage("theirs"))?.status).toBe("delivered");
    expect((await getMessage("own-1"))?.status).toBe("read");
  });
});

describe("history pagination", () => {
  it("pages backwards without overlap or gaps and reports the end", async () => {
    const rows = [];
    for (let i = 1; i <= 120; i++) {
      rows.push(msg({ id: `h-${i}`, roomCode: "room-pg", lamport: i }));
    }
    await bulkPutMessages(rows);

    const page1 = await getMessages("room-pg");
    expect(page1).toHaveLength(50);
    expect(page1[0].lamport).toBe(71);
    expect(page1[49].lamport).toBe(120);

    const page2 = await getMessages("room-pg", page1[0].lamport);
    expect(page2).toHaveLength(50);
    expect(page2[0].lamport).toBe(21);
    expect(page2[49].lamport).toBe(70);

    const page3 = await getMessages("room-pg", page2[0].lamport);
    expect(page3).toHaveLength(20);
    expect(page3[0].lamport).toBe(1);

    expect(await getMessages("room-pg", page3[0].lamport)).toHaveLength(0);

    const ids = new Set([...page1, ...page2, ...page3].map((m) => m.id));
    expect(ids.size).toBe(120);

    // The sync path reads the same history unpaged, in lamport order.
    const all = await getAllMessages("room-pg");
    expect(all).toHaveLength(120);
    expect(all[0].lamport).toBe(1);
    expect(all[119].lamport).toBe(120);
  });
});
