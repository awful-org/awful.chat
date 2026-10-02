import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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
  senderMaxLamports,
  getMessagesAboveWatermarks,
  commitWatermark,
  heldWatermarks,
  holdWatermarks,
  releaseWatermarks,
  watermarksHeld,
  setDeletedFloor,
  deleteMessagesForRoom,
  getDeletedFloor,
  updateMessageStatus,
  wipeLocalDatabase,
  type Room,
  nextDmLamport,
  dedupePhonebook,
  putPhonebookEntry,
  getPhonebookEntries,
  markOwnMessagesReadUpTo,
  getOwnProfile,
  putPeerProfile,
  putOwnProfile,
  updateOwnProfile,
  getAllMessages,
  getAttachmentsWithData,
  getSeedableFiles,
  attachmentEpoch,
  putAttachment,
  getAttachmentsByInfoHash,
  updateAttachmentStatus,
  updateAttachmentData,
  getDB,
  migrateAtRest,
  addRoomParticipant,
  addRoomParticipants,
  MAX_ROOM_PARTICIPANTS,
  updateParticipantLastSeen,
  removeRoomParticipant,
  cleanupInactiveParticipants,
  getRoomParticipants,
  setRoomPinned,
  setRoomPositions,
  setMessagePinned,
  deleteRoom,
} from "./storage";
import { initStorageCrypto, clearStorageCrypto } from "./storage-crypto";
import { STORE_SPECS, inspectRow, isCurrentAad, sealRow } from "./storage-crypto";
import { getAllRooms as allRooms, putRoom as saveRoomRow, getRoom as roomByCode } from "./storage";
import { MessageType, type Message } from "./types/message";
import { lockIdentity } from "./identity/identity";

const TEST_KEY = new Uint8Array(32).fill(42);

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
  await initStorageCrypto(TEST_KEY);
  await wipeLocalDatabase();
  seq = 0;
});

// Clean up after all tests to avoid affecting other test suites
afterEach(() => {
  vi.restoreAllMocks();
  clearStorageCrypto();
});

describe("identity-owned writes", () => {
  it.each(["message", "room", "watermark"])("default %s guard rejects lock during pre-transaction encryption", async kind => {
    let release!: () => void;
    let entered!: () => void;
    const pause = new Promise<void>(r => { release = r; });
    const encrypting = new Promise<void>(r => { entered = r; });
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
      entered(); await pause; return encrypt(...args);
    });
    const writing = kind === "message" ? putMessage(msg({ id: "stale" }))
      : kind === "room" ? putRoom({ roomCode: "room-a", type: "text", name: "Private", createdAt: 1, lastSeenLamport: 0, participants: [] })
      : setWatermark("room-a", "alice", 99);
    const rejected = expect(writing).rejects.toThrow();
    await encrypting;
    lockIdentity();
    await initStorageCrypto(TEST_KEY); // same key, new unlock
    release();
    await rejected;
    expect(await getMessage("stale")).toBeUndefined();
    expect(await getRoom("room-a")).toBeUndefined();
    expect(await getWatermark("room-a", "alice")).toBe(0);
  });
  const attachment = { id: "attachment-owned", messageId: "m", roomCode: "room-a",
    infoHash: "hash-owned", filename: "file", mimeType: "text/plain", size: 1,
    createdAt: 1, status: "pending" as const };

  it.each(["insert", "status", "data"])("revokes an attachment %s while encryption is pending", async operation => {
    if (operation !== "insert") await putAttachment(attachment);
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(r => { release = r; });
    const encrypting = new Promise<void>(r => { entered = r; });
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
      entered(); await paused; return encrypt(...args);
    });
    let active = true;
    const guard = () => { if (!active) throw new Error("Identity changed"); };
    const writing = operation === "insert" ? putAttachment(attachment, guard)
      : operation === "status" ? updateAttachmentStatus(attachment.id, "seeding", guard)
      : updateAttachmentData(attachment.id, new ArrayBuffer(1), guard);
    const rejected = expect(writing).rejects.toThrow("Identity changed");
    await encrypting;
    active = false;
    release();
    await rejected;
    const rows = await getAttachmentsByInfoHash(attachment.infoHash);
    if (operation === "insert") expect(rows).toEqual([]);
    else { expect(rows[0].status).toBe("pending"); expect(rows[0].data).toBeUndefined(); }
  });

  it("re-seals downloaded bytes when seeding advances during encryption", async () => {
    await putAttachment(attachment);
    let release!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(r => { release = r; });
    const encrypting = new Promise<void>(r => { entered = r; });
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
      entered(); await paused; return encrypt(...args);
    });
    const bytes = new Uint8Array([42]).buffer;
    const writing = updateAttachmentData(attachment.id, bytes);
    await encrypting;
    await updateAttachmentStatus(attachment.id, "seeding");
    release();
    await writing;
    const rows = await getAttachmentsByInfoHash(attachment.infoHash);
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("seeding");
    expect(rows[0].data).toEqual(bytes);
  });

  it("does not commit a message when ownership is revoked while encryption is pending", async () => {
    let release!: () => void;
    let entered!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    const encrypting = new Promise<void>(resolve => { entered = resolve; });
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
      entered();
      await pending;
      return encrypt(...args);
    });
    let ownsIdentity = true;
    const message = msg();
    const writing = putMessage(message, () => {
      if (!ownsIdentity) throw new Error("Identity changed");
    });
    const rejected = expect(writing).rejects.toThrow("Identity changed");
    await encrypting;
    ownsIdentity = false;
    release();
    await rejected;
    expect(await getMessage(message.id)).toBeUndefined();
  });

  it("rejects revoked history, room and watermark writes without changing storage", async () => {
    const revoked = () => { throw new Error("Identity changed"); };
    const message = msg();
    await expect(bulkPutMessages([message], revoked)).rejects.toThrow("Identity changed");
    await expect(putRoom({ roomCode: "room-a", type: "text", name: "old identity",
      createdAt: 1, lastSeenLamport: 0, participants: [] }, revoked))
      .rejects.toThrow("Identity changed");
    await expect(setWatermark("room-a", "alice", 10, revoked)).rejects.toThrow("Identity changed");
    expect(await getMessage(message.id)).toBeUndefined();
    expect(await getRoom("room-a")).toBeUndefined();
    expect(await getWatermark("room-a", "alice")).toBe(0);
  });
});

describe("watermarks", () => {
  it("keeps a deleted conversation's floor through the room's deletion", async () => {
    await setWatermark("dm-x", "did:key:zPeer", 42);
    await setDeletedFloor("dm-x", "did:key:zPeer", 42);
    await deleteMessagesForRoom("dm-x");
    expect(await getWatermark("dm-x", "did:key:zPeer")).toBe(0);
    expect(await getDeletedFloor("dm-x", "did:key:zPeer")).toBe(42);
    expect(await getWatermarksForRoom("dm-x")).toEqual({});
  });

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

  it("waits while a push holds the room, and writes what waited on release", async () => {
    holdWatermarks("room-a");
    await setWatermark("room-a", "alice", 7);
    await setWatermark("room-a", "alice", 5);
    await setWatermark("room-b", "bob", 3);
    // Not written, so no digest advertises it yet.
    expect(await getWatermarksForRoom("room-a")).toEqual({});
    expect(await getWatermark("room-b", "bob")).toBe(3);
    // A completed push's own claim is proved, so it does not wait.
    await commitWatermark("room-a", "carol", 4);
    expect(await getWatermarksForRoom("room-a")).toEqual({ carol: 4 });
    await releaseWatermarks("room-a");
    expect(await getWatermarksForRoom("room-a")).toEqual({ alice: 7, carol: 4 });
    await setWatermark("room-a", "alice", 9);
    expect(await getWatermark("room-a", "alice")).toBe(9);
  });

  it("reads how far a sender reached, an advance still waiting on a hold included", async () => {
    await setWatermark("room-a", "alice", 5);
    holdWatermarks("room-a");
    await setWatermark("room-a", "alice", 7);
    // The row behind 7 is stored: a deleted DM's floor must cover it.
    expect(await getWatermark("room-a", "alice")).toBe(7);
    expect(heldWatermarks("room-a")).toEqual(new Map([["alice", 7]]));
    expect(await getWatermarksForRoom("room-a")).toEqual({ alice: 5 });
  });

  it("forgets what waited when the room's history is deleted", async () => {
    holdWatermarks("room-a");
    await setWatermark("room-a", "alice", 7);
    await deleteMessagesForRoom("room-a");
    expect(watermarksHeld("room-a")).toBe(false);
    await releaseWatermarks("room-a");
    expect(await getWatermark("room-a", "alice")).toBe(0);
  });
});

describe("what a digest and a push read", () => {
  it("reads a room once for its senders, and stays current as rows are stored", async () => {
    await bulkPutMessages([msg({ senderId: "alice" }), msg({ senderId: "bob" })]);
    const getAll = vi.spyOn(IDBIndex.prototype, "getAll");
    expect(await senderMaxLamports("room-a")).toEqual(new Map([["alice", 1], ["bob", 2]]));
    const reads = getAll.mock.calls.length;
    expect(reads).toBeGreaterThan(0);
    await putMessage(msg({ senderId: "alice" }));
    await bulkPutMessages([msg({ senderId: "carol" })]);
    for (let i = 0; i < 5; i++) {
      expect(await senderMaxLamports("room-a")).toEqual(
        new Map([["alice", 3], ["bob", 2], ["carol", 4]])
      );
    }
    // Every digest after the first is answered from memory.
    expect(getAll.mock.calls.length).toBe(reads);
  });

  it("forgets a room whose history is deleted", async () => {
    await bulkPutMessages([msg({ senderId: "alice" })]);
    expect(await senderMaxLamports("room-a")).toEqual(new Map([["alice", 1]]));
    await deleteMessagesForRoom("room-a");
    expect(await senderMaxLamports("room-a")).toEqual(new Map());
  });

  it("reads a push only from the lowest watermark the peer has for anyone we hold", async () => {
    const rows = Array.from({ length: 100 }, (_, i) =>
      msg({ senderId: i % 2 ? "alice" : "bob" }));
    await bulkPutMessages(rows);
    // The room's senders are known already: any digest before this one read them.
    await senderMaxLamports("room-a");
    const getAll = vi.spyOn(IDBIndex.prototype, "getAll");
    const missing = await getMessagesAboveWatermarks("room-a", { alice: 95, bob: 90 });
    // bob wrote the odd lamports, alice the even ones.
    expect(missing.map((m) => m.lamport)).toEqual([91, 93, 95, 96, 97, 98, 99, 100]);
    const lowest = getAll.mock.calls.map(([range]) => (range as IDBKeyRange).lower[1]);
    expect(Math.min(...lowest)).toBe(91);
  });

  it("still reads everything for a peer that lacks one of our senders", async () => {
    await bulkPutMessages([msg({ senderId: "alice" }), msg({ senderId: "bob" })]);
    const missing = await getMessagesAboveWatermarks("room-a", { alice: 1 });
    expect(missing.map((m) => m.senderId)).toEqual(["bob"]);
    expect(await getMessagesAboveWatermarks("room-a", { alice: 1, bob: 2 })).toEqual([]);
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

describe("sidebar pin and position live on the room record", () => {
  const room = (roomCode: string): Room => ({
    roomCode,
    type: "text",
    name: roomCode,
    lastSeenLamport: 0,
    createdAt: 0,
    participants: [],
  });

  it("pins and unpins, leaving the rest of the record alone", async () => {
    await putRoom(room("room-a"));
    await markRoomSeen("room-a", 5);
    await setRoomPinned("room-a", 123);
    expect((await getRoom("room-a"))?.pinnedAt).toBe(123);
    expect((await getRoom("room-a"))?.lastSeenLamport).toBe(5);
    await setRoomPinned("room-a", null);
    expect(await getRoom("room-a")).not.toHaveProperty("pinnedAt");
  });

  it("numbers rooms by the order given", async () => {
    await putRoom(room("room-a"));
    await putRoom(room("room-b"));
    await setRoomPositions(["room-b", "room-a"]);
    expect((await getRoom("room-b"))?.position).toBe(0);
    expect((await getRoom("room-a"))?.position).toBe(1);
  });

  it("pins messages in pin order and unpins them, idempotently", async () => {
    await putRoom(room("room-a"));
    await setMessagePinned("room-a", "m1", true);
    await setMessagePinned("room-a", "m2", true);
    await setMessagePinned("room-a", "m1", true);
    expect((await getRoom("room-a"))?.pinnedMessages).toEqual(["m1", "m2"]);
    await setMessagePinned("room-a", "m1", false);
    expect((await getRoom("room-a"))?.pinnedMessages).toEqual(["m2"]);
  });

  it("seals pins and positions with the rest of the record", async () => {
    await putRoom(room("room-a"));
    await setRoomPinned("room-a", 123);
    await setMessagePinned("room-a", "m1", true);
    const raw = await (await getDB()).getAll("rooms");
    const onDisk = JSON.stringify(raw);
    // Only the store's clear fields may be readable on disk.
    expect(onDisk).not.toContain("m1");
    expect(onDisk).not.toContain("pinnedMessages");
    expect(onDisk).not.toContain("pinnedAt");
  });

  it("keeps a pin written at the same moment as a seen watermark", async () => {
    await putRoom(room("room-a"));
    // Both read-modify-write the same record; interleaved, the second write
    // put back what the first had not seen yet and the pin was gone.
    await Promise.all([
      markRoomSeen("room-a", 9),
      setRoomPinned("room-a", 123),
      setMessagePinned("room-a", "m1", true),
      markRoomSeen("room-a", 10),
    ]);
    const stored = await getRoom("room-a");
    expect(stored?.pinnedAt).toBe(123);
    expect(stored?.pinnedMessages).toEqual(["m1"]);
    expect(stored?.lastSeenLamport).toBe(10);
  });

  it("goes with the room when it is removed", async () => {
    await putRoom(room("room-a"));
    await setRoomPinned("room-a", 1);
    await deleteRoom("room-a");
    expect(await getRoom("room-a")).toBeUndefined();
  });
});

describe("message pagination", () => {
  it("loads every equal-counter message exactly once across page boundaries", async () => {
    const rows = Array.from({ length: 123 }, (_, i) => msg({
      id: `tied-${String(i).padStart(3, "0")}`, lamport: 7,
      timestamp: i % 2 ? 1 : Date.UTC(2036, 0, 1),
    }));
    await bulkPutMessages(rows);
    const found: Message[] = [];
    let before: Pick<Message, "lamport" | "id"> | undefined;
    for (;;) {
      const page = await getMessages("room-a", before);
      if (!page.length) break;
      found.unshift(...page);
      before = page[0];
    }
    expect(found.map(m => m.id)).toEqual(rows.map(m => m.id));
    // The cursor may outlive deletion of the boundary row.
    expect((await getMessages("room-a", { lamport: 7, id: "tied-073a" }))[49].id).toBe("tied-073");
  });

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
  it("ignores the wall clock for a new conversation", async () => {
    expect(await nextDmLamport("dm-clock-a", 5_000)).toBe(1);
  });

  it("floors to last-issued + 1 when the clock runs behind", async () => {
    const first = await nextDmLamport("dm-clock-b", 9_000);
    const second = await nextDmLamport("dm-clock-b", 1_000);
    expect(first).toBe(1);
    expect(second).toBe(2);
  });

  it("floors to the stored room maximum", async () => {
    await bulkPutMessages([
      msg({ id: "dm-m1", roomCode: "dm-clock-c", lamport: 7_777 }),
    ]);
    expect(await nextDmLamport("dm-clock-c", 100)).toBe(7_778);
  });

  it("continues above a legacy future-dated DM counter after the PC clock is corrected", async () => {
    const legacy = Date.UTC(2036, 0, 1);
    await putMessage(msg({ id: "legacy-future", roomCode: "dm-legacy-future", lamport: legacy }));
    const issued = await Promise.all(Array.from({ length: 4 }, () => nextDmLamport("dm-legacy-future", 1)));
    expect(issued).toEqual([legacy + 1, legacy + 2, legacy + 3, legacy + 4]);
    await putRoom({ roomCode: "dm-legacy-future", type: "text", name: "Legacy", createdAt: 1, participants: [], lastSeenLamport: legacy });
    await putMessage(msg({ id: "corrected-clock", roomCode: "dm-legacy-future", lamport: issued[0], timestamp: 1, senderId: "peer" }));
    expect(await getUnreadCount("dm-legacy-future", legacy, "self")).toBe(1);
    await markRoomSeen("dm-legacy-future", issued[0]);
    expect((await getRoom("dm-legacy-future"))?.lastSeenLamport).toBe(issued[0]);
  });

  it("respects durable sync/read watermarks after history is pruned", async () => {
    await putRoom({ roomCode: "dm-pruned", type: "text", name: "Pruned", createdAt: 1, participants: [], lastSeenLamport: 500 });
    await setWatermark("dm-pruned", "did:peer", 600);
    expect(await nextDmLamport("dm-pruned", 1)).toBe(601);
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

describe("own profile survives a second device", () => {
  // Reported from real use: name and picture gone after a refresh. Profiles
  // are keyed by did and getOwnProfile finds the row flagged isMe, so an
  // incoming profile stored under our OWN did replaced it with isMe:false.
  // The peer that carries our did is our own other browser - the restore key
  // gives it the same identity - so this needs no attacker to happen.
  it("finds the profile again when the isMe flag was overwritten", async () => {
    await putOwnProfile({
      did: "did:key:zMe",
      isMe: true,
      nickname: "Me",
      updatedAt: 1_000,
    });
    // What the old code did on hearing from our second device.
    await putPeerProfile({
      did: "did:key:zMe",
      isMe: false,
      nickname: "Me",
      updatedAt: 2_000,
    });

    expect(await getOwnProfile()).toBeUndefined();
    const recovered = await getOwnProfile("did:key:zMe");
    expect(recovered?.nickname).toBe("Me");
    // ...and the flag is repaired, so it is found without help next time.
    expect((await getOwnProfile())?.nickname).toBe("Me");
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

describe("at-rest encryption", () => {
  it("rows land sealed - a raw dump shows no plaintext", async () => {
    await putMessage(
      msg({ id: "sealed-1", roomCode: "room-enc", content: "top secret words" })
    );
    const raw = await (await getDB()).get("messages", "sealed-1");
    expect(JSON.stringify(raw)).not.toContain("top secret");
    expect(JSON.stringify(raw)).not.toContain("Alice");
    const back = await getMessage("sealed-1");
    expect(back?.content).toBe("top secret words");
    expect(back?.senderName).toBe("Alice");
  });

  it("migrateAtRest deletes a row the previous sweep sealed twice, so it can be re-synced", async () => {
    await saveRoomRow({
      roomCode: "X5M9PR989E7KA",
      name: "probe",
      type: "text",
      lastSeenLamport: 0,
      createdAt: 1,
      participants: [],
      participantLastSeen: {},
    });
    const db = await getDB();
    const [raw] = await db.getAll("rooms");
    // The 2026-09-02 sweep: sealRow over the sealed row, written back under
    // the same (blinded) key. The room now opens to its own hash.
    const twice = await sealRow(raw as unknown as Record<string, unknown>, STORE_SPECS.rooms);
    await db.put("rooms", twice as never);
    const broken = await roomByCode("X5M9PR989E7KA");
    expect(broken?.roomCode).not.toBe("X5M9PR989E7KA");

    await migrateAtRest();

    // Gone, not duplicated and not crashing the room list.
    expect(await allRooms()).toEqual([]);
    expect(await db.getAll("rooms")).toEqual([]);
    expect(await roomByCode("X5M9PR989E7KA")).toBeUndefined();
    // The room can be recreated cleanly under the same key.
    await saveRoomRow({
      roomCode: "X5M9PR989E7KA",
      name: "probe again",
      type: "text",
      lastSeenLamport: 0,
      createdAt: 2,
      participants: [],
      participantLastSeen: {},
    });
    const [fresh] = await db.getAll("rooms");
    expect(isCurrentAad(fresh)).toBe(true);
    expect((await inspectRow(fresh, STORE_SPECS.rooms)).value).toMatchObject({ name: "probe again" });
    expect((await roomByCode("X5M9PR989E7KA"))?.name).toBe("probe again");
  });

  it("migrateAtRest seals legacy plaintext rows in place", async () => {
    const database = await getDB();
    // A row written by a pre-encryption build: plaintext, no _enc.
    await database.put(
      "messages",
      msg({ id: "legacy-1", roomCode: "room-mig", content: "readable" })
    );
    await migrateAtRest();
    const raw = await database.get("messages", "legacy-1");
    expect(JSON.stringify(raw)).not.toContain("readable");
    const opened = await getMessage("legacy-1");
    expect(opened?.content).toBe("readable");
  });
});

describe("history pagination", () => {
  it("plugin updates never consume page slots", async () => {
    // One steam-roulette link writes ~40 PluginUpdate rows; letting them
    // fill the newest page hid two weeks of real messages behind one
    // afternoon of plugin traffic.
    const rows = [];
    for (let i = 1; i <= 5; i++) {
      rows.push(msg({ id: `old-${i}`, roomCode: "room-pu", lamport: i }));
    }
    for (let i = 6; i <= 80; i++) {
      rows.push(
        msg({
          id: `upd-${i}`,
          roomCode: "room-pu",
          lamport: i,
          type: MessageType.PluginUpdate,
          content: JSON.stringify({ pluginId: "p", cardId: "c", data: {} }),
        })
      );
    }
    await bulkPutMessages(rows);

    const page = await getMessages("room-pu");
    expect(page.map((m) => m.id)).toEqual([
      "old-1",
      "old-2",
      "old-3",
      "old-4",
      "old-5",
    ]);
    // The unpaged sync read still sees everything.
    expect(await getAllMessages("room-pu")).toHaveLength(80);
  });

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

describe("getAttachmentsWithData", () => {
  it("returns saved bytes even when the status is stuck pre-complete", async () => {
    const db = await getDB();
    await db.put("attachments", {
      id: "att-stuck",
      roomCode: "room-att",
      messageId: "m-att",
      filename: "pic.png",
      mimeType: "image/png",
      size: 3,
      infoHash: "hash-stuck",
      status: "downloading",
      createdAt: 1,
      data: new Uint8Array([1, 2, 3]).buffer,
    });
    await db.put("attachments", {
      id: "att-empty",
      roomCode: "room-att",
      messageId: "m-att2",
      filename: "no-data.png",
      mimeType: "image/png",
      size: 3,
      infoHash: "hash-empty",
      status: "complete",
      createdAt: 2,
    });
    const withData = await getAttachmentsWithData("room-att");
    expect(withData.map((a) => a.id)).toEqual(["att-stuck"]);
  });
});

describe("getSeedableFiles", () => {
  it("returns one descriptor per infoHash, only for rows that kept the bytes", async () => {
    const before = attachmentEpoch();
    const base = {
      roomCode: "room-a",
      messageId: "m1",
      filename: "cat.png",
      mimeType: "image/png",
      size: 4,
      status: "seeding" as const,
      createdAt: 1,
    };
    // Same file quoted in two messages, plus one whose bytes were never kept.
    await putAttachment({ ...base, id: "a1", infoHash: "h1", data: new ArrayBuffer(4) });
    await putAttachment({ ...base, id: "a2", infoHash: "h1", messageId: "m2", data: new ArrayBuffer(4) });
    await putAttachment({ ...base, id: "a3", infoHash: "h2", roomCode: "room-b" });

    const seedable = await getSeedableFiles();
    expect(seedable.map((s) => s.file.infoHash).sort()).toEqual(["h1"]);
    expect(seedable[0].roomCode).toBe("room-a");
    expect(attachmentEpoch()).toBeGreaterThan(before);
  });
});

describe("updateAttachmentStatus", () => {
  it("keeps the row readable: status is AAD-bound, so it must be re-sealed", async () => {
    await putAttachment({
      id: "a-status",
      infoHash: "h-status",
      roomCode: "room-a",
      messageId: "m1",
      filename: "cat.png",
      mimeType: "image/png",
      size: 4,
      status: "downloading",
      createdAt: 1,
      data: new ArrayBuffer(4),
    });
    await updateAttachmentStatus("a-status", "complete");
    // A patched-in-place sealed row fails its AAD check and is dropped on
    // read, which showed up as zero rows here.
    const rows = await getAttachmentsByInfoHash("h-status");
    expect(rows.map((r) => r.status)).toEqual(["complete"]);
    // Never regress.
    await updateAttachmentStatus("a-status", "downloading");
    expect((await getAttachmentsByInfoHash("h-status"))[0].status).toBe("complete");
  });
});

describe("unreadable rows repair themselves", () => {
  // Breaks a sealed row the way older builds did: a clear field rewritten
  // around the seal fails the AAD check, so the row no longer decrypts.
  async function breakOnlyRow(store: "watermarks" | "attachments", patch: object) {
    const db = await getDB();
    const rows = await db.getAll(store);
    expect(rows).toHaveLength(1);
    await db.put(store, { ...rows[0], ...patch } as never);
  }

  it("a watermark that will not open is removed, and the sync can rebuild it", async () => {
    await setWatermark("room-a", "alice", 10);
    await breakOnlyRow("watermarks", { maxLamport: 50 });
    await setWatermark("room-a", "bob", 5);

    // Alice is missing, as before - but her dead row is gone now instead of
    // advertising lamport 50 in the clear forever.
    expect(await getWatermarksForRoom("room-a")).toEqual({ bob: 5 });
    expect(await (await getDB()).count("watermarks")).toBe(1);

    await setWatermark("room-a", "alice", 7);
    expect(await getWatermarksForRoom("room-a")).toEqual({ alice: 7, bob: 5 });
  });

  it("setWatermark replaces an unreadable row even when it claims to be newer", async () => {
    // Written the way an older build left it, not by this session's
    // setWatermark: the trap is a dead row whose clear maxLamport beat
    // every write after it.
    const sealed = await sealRow(
      { id: "room-a:alice", roomCode: "room-a", senderId: "alice", maxLamport: 10 },
      STORE_SPECS.watermarks
    );
    await (await getDB()).put("watermarks", sealed as never);
    await breakOnlyRow("watermarks", { maxLamport: 50 });

    await setWatermark("room-a", "alice", 20);
    expect(await getWatermarksForRoom("room-a")).toEqual({ alice: 20 });
    // And the regression guard still holds once the row is a good one.
    await setWatermark("room-a", "alice", 3);
    expect(await getWatermarksForRoom("room-a")).toEqual({ alice: 20 });
  });

  it("one unreadable attachment neither hides the rest from seeding nor stays", async () => {
    const base = {
      roomCode: "room-a",
      messageId: "m1",
      filename: "cat.png",
      mimeType: "image/png",
      size: 4,
      status: "seeding" as const,
      createdAt: 1,
      data: new ArrayBuffer(4),
    };
    await putAttachment({ ...base, id: "dead", infoHash: "h-dead" });
    await breakOnlyRow("attachments", { status: "complete" });
    await putAttachment({ ...base, id: "good", infoHash: "h-good" });

    // This threw on the dead row and announced nothing at all.
    const seedable = await getSeedableFiles();
    expect(seedable.map((s) => s.file.infoHash)).toEqual(["h-good"]);
    expect(await (await getDB()).get("attachments", "dead")).toBeUndefined();
    expect(await (await getDB()).get("attachments", "good")).toBeDefined();
  });
});

describe("room participants and persistence", () => {
  const baseRoom: Room = {
    roomCode: "room-persist",
    type: "text",
    name: "Persistent Room",
    lastSeenLamport: 0,
    createdAt: 0,
    participants: [],
  };

  it("adds a new participant with current timestamp", async () => {
    await putRoom(baseRoom);
    const now = Date.now();
    await addRoomParticipant("room-persist", "did:key:zAlice");
    const room = await getRoom("room-persist");
    expect(room?.participants).toContain("did:key:zAlice");
    expect(room?.participantLastSeen?.["did:key:zAlice"]).toBeGreaterThanOrEqual(now);
  });

  it("updates timestamp for existing participant", async () => {
    await putRoom(baseRoom);
    const before = Date.now();
    await addRoomParticipant("room-persist", "did:key:zBob");
    // Wait a tiny bit to ensure different timestamp
    await new Promise((resolve) => setTimeout(resolve, 1));
    const after = Date.now();
    const firstTimestamp = (await getRoom("room-persist"))?.participantLastSeen?.[
      "did:key:zBob"
    ];
    expect(firstTimestamp).toBeGreaterThanOrEqual(before);
    expect(firstTimestamp).toBeLessThanOrEqual(after);
    await updateParticipantLastSeen("room-persist", "did:key:zBob");
    const secondTimestamp = (await getRoom("room-persist"))?.participantLastSeen?.[
      "did:key:zBob"
    ];
    expect(secondTimestamp).toBeGreaterThanOrEqual(after);
  });

  it("adds many in one go, never past the cap, never moving last-seen back", async () => {
    await putRoom(baseRoom);
    await addRoomParticipant("room-persist", "did:key:zKept");
    const kept = (await getRoom("room-persist"))!.participantLastSeen!["did:key:zKept"];
    const flood = Array.from(
      { length: MAX_ROOM_PARTICIPANTS + 50 },
      (_, i) => [`did:key:zJunk${i}`, 1] as const
    );
    await addRoomParticipants("room-persist", [["did:key:zKept", 1], ...flood]);
    const room = await getRoom("room-persist");
    expect(room?.participants).toHaveLength(MAX_ROOM_PARTICIPANTS);
    expect(room?.participants).toContain("did:key:zKept");
    expect(room?.participantLastSeen?.["did:key:zKept"]).toBe(kept);
  });

  it("removes a participant and its timestamp", async () => {
    await putRoom(baseRoom);
    await addRoomParticipant("room-persist", "did:key:zCarol");
    let room = await getRoom("room-persist");
    expect(room?.participants).toContain("did:key:zCarol");
    await removeRoomParticipant("room-persist", "did:key:zCarol");
    room = await getRoom("room-persist");
    expect(room?.participants).not.toContain("did:key:zCarol");
    expect(room?.participantLastSeen?.["did:key:zCarol"]).toBeUndefined();
  });

  it("survives cleanup if seen within 30 days", async () => {
    await putRoom(baseRoom);
    const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000 + 1000; // 1 second ago in the 30-day window
    await putRoom({
      ...baseRoom,
      participants: ["did:key:zAlice"],
      participantLastSeen: {
        "did:key:zAlice": thirtyDaysAgo,
      },
    });
    const removed = await cleanupInactiveParticipants("room-persist");
    expect(removed).not.toContain("did:key:zAlice");
    const room = await getRoom("room-persist");
    expect(room?.participants).toContain("did:key:zAlice");
  });

  it("removes members not seen for 30+ days", async () => {
    await putRoom(baseRoom);
    const thirtyOneDaysAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await putRoom({
      ...baseRoom,
      participants: ["did:key:zBob"],
      participantLastSeen: {
        "did:key:zBob": thirtyOneDaysAgo,
      },
    });
    const removed = await cleanupInactiveParticipants("room-persist");
    expect(removed).toContain("did:key:zBob");
    const room = await getRoom("room-persist");
    expect(room?.participants).not.toContain("did:key:zBob");
  });

  it("survives the first cleanup when no timestamp exists (migration safety)", async () => {
    // This test covers the trap where a missing timestamp must NOT mean
    // infinitely stale. During the migration from never-recording-timestamps
    // to the new system, existing members with no timestamp should survive
    // the first cleanup run.
    await putRoom({
      ...baseRoom,
      participants: ["did:key:zCarol", "did:key:zDave"],
      // participantLastSeen is missing entirely, simulating pre-migration state
    });
    const removed = await cleanupInactiveParticipants("room-persist");
    expect(removed).toHaveLength(0);
    const room = await getRoom("room-persist");
    expect(room?.participants).toContain("did:key:zCarol");
    expect(room?.participants).toContain("did:key:zDave");
  });

  it("never writes a peerId to participants (trap 2)", async () => {
    // A raw peerId written into participants is never matched by a leave
    // (keyed by DID) and ghosts the member list for 30 days. The validation
    // check in addRoomParticipant should prevent this.
    await putRoom(baseRoom);
    // Try to add a peerId (starts with Qm, not did:)
    await addRoomParticipant("room-persist", "QmPeerId123");
    const room = await getRoom("room-persist");
    // The peerId should NOT be in participants because addRoomParticipant
    // validates it starts with "did:"
    expect(room?.participants).not.toContain("QmPeerId123");
    expect(room?.participants).toHaveLength(0);
  });

  it("preserves multiple participants correctly", async () => {
    await putRoom(baseRoom);
    const dids = ["did:key:zA", "did:key:zB", "did:key:zC"];
    for (const did of dids) {
      await addRoomParticipant("room-persist", did);
    }
    const room = await getRoom("room-persist");
    expect(room?.participants).toHaveLength(3);
    expect(new Set(room?.participants)).toEqual(new Set(dids));
    // All should have timestamps
    for (const did of dids) {
      expect(room?.participantLastSeen?.[did]).toBeGreaterThan(0);
    }
  });

  it("handles mixed recent and stale participants in cleanup", async () => {
    const now = Date.now();
    const thirtyOneDaysAgo = now - 31 * 24 * 60 * 60 * 1000;
    const tenDaysAgo = now - 10 * 24 * 60 * 60 * 1000;
    await putRoom({
      ...baseRoom,
      participants: ["did:key:zStale", "did:key:zRecent", "did:key:zNoTimestamp"],
      participantLastSeen: {
        "did:key:zStale": thirtyOneDaysAgo,
        "did:key:zRecent": tenDaysAgo,
        // zNoTimestamp has no entry, testing migration path
      },
    });
    const removed = await cleanupInactiveParticipants("room-persist");
    expect(removed).toEqual(["did:key:zStale"]);
    const room = await getRoom("room-persist");
    expect(room?.participants).toEqual(
      expect.arrayContaining(["did:key:zRecent", "did:key:zNoTimestamp"])
    );
    expect(room?.participants).not.toContain("did:key:zStale");
  });
});

// The 30-day rule has to apply to members who left before timestamps existed,
// not just to ones seen since. Defaulting a missing timestamp to "now" on every
// read - rather than writing it once - would make such a member immortal: each
// pass re-reads undefined, re-defaults, and the cutoff can never be crossed.
describe("participant expiry reaches members who predate timestamps", () => {
  it("backfills a missing timestamp instead of only defaulting it", async () => {
    const db = await getDB();
    await db.clear("rooms");
    await putRoom({
      roomCode: "backfill-room",
      type: "text",
      name: "R",
      lastSeenLamport: 0,
      createdAt: 1,
      participants: ["did:key:zGhost"],
    } as never);

    // First pass: nobody is removed, but the clock must now be started.
    expect(await cleanupInactiveParticipants("backfill-room")).toEqual([]);
    const after = await getRoom("backfill-room");
    expect(after?.participants).toEqual(["did:key:zGhost"]);
    expect(after?.participantLastSeen?.["did:key:zGhost"]).toBeTypeOf("number");
  });

  it("removes that member once the backfilled clock ages past the window", async () => {
    const db = await getDB();
    await db.clear("rooms");
    const longAgo = Date.now() - 31 * 24 * 60 * 60 * 1000;
    await putRoom({
      roomCode: "aged-room",
      type: "text",
      name: "R",
      lastSeenLamport: 0,
      createdAt: 1,
      participants: ["did:key:zGhost"],
      participantLastSeen: { "did:key:zGhost": longAgo },
    } as never);

    expect(await cleanupInactiveParticipants("aged-room")).toEqual([
      "did:key:zGhost",
    ]);
    expect((await getRoom("aged-room"))?.participants).toEqual([]);
  });
});
