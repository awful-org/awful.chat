import { afterEach, beforeEach, describe, expect, it } from "vitest";
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
  putPeerProfile,
  putOwnProfile,
  updateOwnProfile,
  getAllMessages,
  getAttachmentsWithData,
  getSeedableFiles,
  attachmentEpoch,
  putAttachment,
  getDB,
  migrateAtRest,
  addRoomParticipant,
  updateParticipantLastSeen,
  removeRoomParticipant,
  cleanupInactiveParticipants,
  getRoomParticipants,
} from "./storage";
import { initStorageCrypto, clearStorageCrypto } from "./storage-crypto";
import { MessageType, type Message } from "./types/message";

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
  clearStorageCrypto();
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
