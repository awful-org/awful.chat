import { beforeEach, afterEach, describe, expect, it } from "vitest";
import {
  deleteRoomProfilesForRoom, getDB, getOwnRoomProfile, getPeerRoomProfile,
  getRoomDeletionMarker, putOwnRoomProfile, putPeerRoomProfile, putRoom,
  wipeLocalDatabase, type Room,
} from "./storage";
import { clearStorageCrypto, initStorageCrypto } from "./storage-crypto";

const KEY = new Uint8Array(32).fill(42);
const room = (roomCode: string): Room => ({
  roomCode, type: "text", name: roomCode, participants: [],
  createdAt: 10, lastSeenLamport: 0,
});

beforeEach(async () => {
  await initStorageCrypto(KEY);
  await wipeLocalDatabase();
  await putRoom(room("room-a"));
  await putRoom(room("room-b"));
});
afterEach(() => clearStorageCrypto());

describe("room profile storage", () => {
  it("retains own sparse edits and explicit clears across database reads", async () => {
    const avatar = new Uint8Array([1, 2, 3]).buffer;
    await putOwnRoomProfile({
      roomCode: "room-a", did: "did:key:alice", generation: 10,
      fields: { nickname: "Room Alice", bio: null, pfpData: avatar },
      fieldEdits: { nickname: { at: 20, id: "edit-a" }, bio: { at: 21, id: "edit-b" } },
    });
    const stored = await getOwnRoomProfile("room-a", "did:key:alice");
    expect(stored?.fields.nickname).toBe("Room Alice");
    expect(stored?.fields.bio).toBeNull();
    expect(stored?.fields.pfpData).toEqual(avatar);
    expect(stored?.fieldEdits?.bio).toEqual({ at: 21, id: "edit-b" });

    const database = await getDB();
    const raw = await database.getAll("roomProfiles");
    expect(raw).toHaveLength(1);
    expect(JSON.stringify(raw[0])).not.toContain("Room Alice");
    expect(JSON.stringify(raw[0])).not.toContain("room-a");
    expect(JSON.stringify(raw[0])).not.toContain("did:key:alice");
  });

  it("isolates own overrides by room and identity", async () => {
    await putOwnRoomProfile({ roomCode: "room-a", did: "did:key:alice", generation: 10, fields: { nickname: "A" } });
    await putOwnRoomProfile({ roomCode: "room-b", did: "did:key:alice", generation: 10, fields: { nickname: "B" } });
    await putOwnRoomProfile({ roomCode: "room-a", did: "did:key:bob", generation: 10, fields: { nickname: "Bob" } });
    expect((await getOwnRoomProfile("room-a", "did:key:alice"))?.fields.nickname).toBe("A");
    expect((await getOwnRoomProfile("room-b", "did:key:alice"))?.fields.nickname).toBe("B");
    expect((await getOwnRoomProfile("room-a", "did:key:bob"))?.fields.nickname).toBe("Bob");
  });

  it("deletes own and peer records for one room but retains the deletion marker", async () => {
    await putOwnRoomProfile({ roomCode: "room-a", did: "did:key:alice", generation: 10, fields: { bio: null } });
    await putOwnRoomProfile({ roomCode: "room-b", did: "did:key:alice", generation: 10, fields: { nickname: "B" } });
    await putPeerRoomProfile("room-a", 10, { did: "did:key:bob", isMe: false, nickname: "Room Bob", updatedAt: 20 });
    await deleteRoomProfilesForRoom("room-a", 30);
    expect(await getOwnRoomProfile("room-a", "did:key:alice")).toBeUndefined();
    expect(await getPeerRoomProfile("room-a", "did:key:bob")).toBeUndefined();
    expect((await getOwnRoomProfile("room-b", "did:key:alice"))?.fields.nickname).toBe("B");
    expect(await getRoomDeletionMarker("room-a")).toMatchObject({ roomCode: "room-a", generation: 30 });
  });

  it("does not let a stale profile generation repopulate a deleted room", async () => {
    await deleteRoomProfilesForRoom("room-a", 30);
    await expect(putOwnRoomProfile({ roomCode: "room-a", did: "did:key:alice", generation: 10, fields: { nickname: "old" } })).rejects.toThrow(/deleted/);
    expect(await getOwnRoomProfile("room-a", "did:key:alice")).toBeUndefined();
  });
});
