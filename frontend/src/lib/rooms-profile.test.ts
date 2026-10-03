import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getOwnRoomProfile, getPeerRoomProfile, getRoom, getRoomDeletionMarker,
  putOwnRoomProfile, putPeerRoomProfile, putOwnProfile, getOwnProfile,
  wipeLocalDatabase,
} from "./storage";
import { saveRoom, removeRoom, roomsStore } from "./rooms.svelte";
import { resolveRoomProfile } from "./room-profile";
import { clearStorageCrypto, initStorageCrypto } from "./storage-crypto";

const KEY = new Uint8Array(32).fill(42);
beforeEach(async () => {
  await initStorageCrypto(KEY);
  await wipeLocalDatabase();
  roomsStore.rooms = [];
  roomsStore.unreadCounts = new Map();
  roomsStore.lastActivity = new Map();
});
afterEach(() => { vi.restoreAllMocks(); clearStorageCrypto(); });

describe("room profile lifecycle", () => {
  it("deletes own and peer profiles on leave, retaining a sync marker", async () => {
    await saveRoom("room-a", "A");
    await saveRoom("room-b", "B");
    const a = (await getRoom("room-a"))!;
    const b = (await getRoom("room-b"))!;
    await putOwnRoomProfile({ roomCode: "room-a", did: "did:key:alice", generation: a.createdAt, fields: { nickname: "Room Alice" } });
    await putOwnRoomProfile({ roomCode: "room-b", did: "did:key:alice", generation: b.createdAt, fields: { nickname: "Other Alice" } });
    await putPeerRoomProfile("room-a", a.createdAt, { did: "did:key:bob", isMe: false, nickname: "Room Bob", updatedAt: 1 });

    await removeRoom("room-a");

    expect(await getRoom("room-a")).toBeUndefined();
    expect(await getOwnRoomProfile("room-a", "did:key:alice")).toBeUndefined();
    expect(await getPeerRoomProfile("room-a", "did:key:bob")).toBeUndefined();
    expect((await getOwnRoomProfile("room-b", "did:key:alice"))?.fields.nickname).toBe("Other Alice");
    expect((await getRoomDeletionMarker("room-a"))?.generation).toBeGreaterThan(a.createdAt);
  });

  it("intentional rejoin starts a newer generation and inherits current main", async () => {
    await putOwnProfile({ did: "did:key:alice", isMe: true, nickname: "Main", updatedAt: 1 });
    await saveRoom("room-a", "A");
    const oldGeneration = (await getRoom("room-a"))!.createdAt;
    await putOwnRoomProfile({ roomCode: "room-a", did: "did:key:alice", generation: oldGeneration, fields: { nickname: "Old room" } });
    await removeRoom("room-a");
    const marker = (await getRoomDeletionMarker("room-a"))!;
    await saveRoom("room-a", "A again");
    const newGeneration = (await getRoom("room-a"))!.createdAt;

    expect(newGeneration).toBeGreaterThan(marker.generation);
    expect(await getOwnRoomProfile("room-a", "did:key:alice")).toBeUndefined();
    expect(resolveRoomProfile((await getOwnProfile("did:key:alice"))!).nickname).toBe("Main");
    await expect(putOwnRoomProfile({ roomCode: "room-a", did: "did:key:alice", generation: oldGeneration, fields: { nickname: "Stale" } })).rejects.toThrow();
    await expect(putPeerRoomProfile("room-a", oldGeneration, { did: "did:key:bob", isMe: false, nickname: "Stale Bob", updatedAt: 1 })).rejects.toThrow();
    await putOwnRoomProfile({ roomCode: "room-a", did: "did:key:alice", generation: newGeneration, fields: { nickname: "New room" } });
    expect((await getOwnRoomProfile("room-a", "did:key:alice"))?.fields.nickname).toBe("New room");
    expect(await getRoomDeletionMarker("room-a")).toEqual(marker);
  });

  it("rejects an in-flight peer cache write after the room is left", async () => {
    await saveRoom("room-a", "A");
    const generation = (await getRoom("room-a"))!.createdAt;
    let resume!: () => void;
    let entered!: () => void;
    const paused = new Promise<void>(resolve => { resume = resolve; });
    const encrypting = new Promise<void>(resolve => { entered = resolve; });
    const encrypt = crypto.subtle.encrypt.bind(crypto.subtle);
    vi.spyOn(crypto.subtle, "encrypt").mockImplementationOnce(async (...args) => {
      entered(); await paused; return encrypt(...args);
    });
    const writing = putPeerRoomProfile("room-a", generation, {
      did: "did:key:bob", isMe: false, nickname: "Stale Bob", updatedAt: 1,
    });
    const rejected = expect(writing).rejects.toThrow(/deleted/);
    await encrypting;
    await removeRoom("room-a");
    resume();
    await rejected;
    expect(await getPeerRoomProfile("room-a", "did:key:bob")).toBeUndefined();
  });
});
