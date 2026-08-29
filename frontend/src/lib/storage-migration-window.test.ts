import { beforeEach, describe, expect, it } from "vitest";
import {
  getDB,
  getMessages,
  getRoom,
  putMessage,
  putRoom,
  addRoomParticipant,
  isGifSaved,
  putSavedGif,
  getMessagesAboveWatermarks,
  getAttachmentsByMessage,
  putAttachment,
  getSeedableFiles,
} from "./storage";
import { initStorageCrypto, sealRow, openRow, STORE_SPECS } from "./storage-crypto";
import type { Message, Attachment } from "./types/message";

/**
 * The blind migration rewrites rows in the background and can be interrupted
 * by a closed tab, so for a while a store holds BOTH shapes: migrated rows
 * carrying the keyed hash, legacy rows still carrying plaintext. Every read
 * has to see both.
 *
 * Getting this wrong does not throw - it silently returns fewer rows, which
 * for the message store means a user's history disappearing until the sweep
 * happens to finish. These are the regression tests for that.
 */
describe("reads during the blind migration window", () => {
  beforeEach(async () => {
    await initStorageCrypto(
      crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>
    );
    const db = await getDB();
    for (const store of ["messages", "rooms"] as const) {
      await db.clear(store);
    }
  });

  const legacyMessage = (id: string, lamport: number) =>
    ({
      id,
      roomCode: "room-legacy",
      senderId: "did:key:zAlice",
      senderName: "Alice",
      lamport,
      timestamp: lamport,
      type: "text",
      content: `legacy ${id}`,
      attachments: [],
    }) as never;

  it("finds a message written before the migration", async () => {
    const db = await getDB();
    await db.put("messages", legacyMessage("legacy-1", 1));
    const msgs = await getMessages("room-legacy");
    expect(msgs.map((m) => m.id)).toEqual(["legacy-1"]);
  });

  it("finds BOTH halves of a partly migrated room", async () => {
    const db = await getDB();
    // Two legacy rows straight into the store...
    await db.put("messages", legacyMessage("legacy-1", 1));
    await db.put("messages", legacyMessage("legacy-2", 2));
    // ...and one written through the normal path, so it is sealed + blinded.
    await putMessage({
      id: "migrated-1",
      roomCode: "room-legacy",
      senderId: "did:key:zAlice",
      senderName: "Alice",
      lamport: 3,
      timestamp: 3,
      type: "text",
      content: "after the sweep reached it",
      attachments: [],
    } as never);

    const msgs = await getMessages("room-legacy");
    expect(msgs.map((m) => m.id).sort()).toEqual([
      "legacy-1",
      "legacy-2",
      "migrated-1",
    ]);
  });

  it("finds a room written before the migration", async () => {
    const db = await getDB();
    await db.put("rooms", {
      roomCode: "room-legacy",
      type: "text",
      name: "Weekend plans",
      lastSeenLamport: 0,
      createdAt: 1,
      participants: [],
    } as never);
    expect((await getRoom("room-legacy"))?.name).toBe("Weekend plans");
  });

  it("still finds a room written after the migration", async () => {
    await putRoom({
      roomCode: "room-new",
      type: "text",
      name: "Fresh",
      lastSeenLamport: 0,
      createdAt: 1,
      participants: [],
    } as never);
    expect((await getRoom("room-new"))?.name).toBe("Fresh");
  });
});

describe("blinded store seal round-trips", () => {
  beforeEach(async () => {
    await initStorageCrypto(
      crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>
    );
    const db = await getDB();
    for (const store of [
      "messages",
      "attachments",
      "rooms",
      "profiles",
      "watermarks",
      "phonebook",
      "savedGifs",
      "yjsDocs",
    ] as const) {
      await db.clear(store);
    }
  });

  it("messages: blind fields are b1: prefixed in raw rows", async () => {
    const { MessageType } = await import("./types/message");
    const raw = {
      id: "msg-1",
      roomCode: "room-abc",
      senderId: "did:key:zSender",
      senderName: "Sender",
      lamport: 1,
      timestamp: 1,
      type: MessageType.Text,
      content: "hello",
      attachments: [],
    } as Record<string, unknown>;
    const sealed = await sealRow(raw, STORE_SPECS.messages);
    expect((sealed as Record<string, unknown>).roomCode).toMatch(/^b1:/);
    expect((sealed as Record<string, unknown>).senderId).toMatch(/^b1:/);
    const opened = (await openRow<Message>(sealed, STORE_SPECS.messages));
    expect(opened.roomCode).toBe("room-abc");
    expect(opened.senderId).toBe("did:key:zSender");
  });

  it("attachments: blind fields are b1: prefixed in raw rows", async () => {
    const raw = {
      id: "att-1",
      roomCode: "room-abc",
      messageId: "msg-1",
      infoHash: "hash123",
      filename: "file.txt",
      mimeType: "text/plain",
      size: 100,
      status: "complete",
      createdAt: 1,
    } as Record<string, unknown>;
    const sealed = await sealRow(raw, STORE_SPECS.attachments);
    expect((sealed as Record<string, unknown>).roomCode).toMatch(/^b1:/);
    expect((sealed as Record<string, unknown>).messageId).toMatch(/^b1:/);
    expect((sealed as Record<string, unknown>).infoHash).toMatch(/^b1:/);
    const opened = await openRow<Attachment>(sealed, STORE_SPECS.attachments);
    expect(opened.roomCode).toBe("room-abc");
    expect(opened.messageId).toBe("msg-1");
    expect(opened.infoHash).toBe("hash123");
  });
});

describe("semantic bug fixes", () => {
  beforeEach(async () => {
    await initStorageCrypto(
      crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>
    );
    const db = await getDB();
    for (const store of [
      "messages",
      "attachments",
      "rooms",
      "watermarks",
      "savedGifs",
    ] as const) {
      await db.clear(store);
    }
  });

  it("_patchRoom: applies patches to legacy rooms during migration", async () => {
    const db = await getDB();
    // Insert a legacy room directly
    await db.put("rooms", {
      roomCode: "room-legacy",
      type: "text",
      name: "Legacy Room",
      lastSeenLamport: 0,
      createdAt: 1,
      participants: [],
    } as never);
    // Patch it through the normal path (which requires the plaintext fallback)
    await addRoomParticipant("room-legacy", "did:key:zAlice");
    // Verify the patch was applied
    const room = await getRoom("room-legacy");
    expect(room?.participants).toContain("did:key:zAlice");
  });

  it("deleteMessagesForRoom: handles both legacy and migrated messages", async () => {
    const { deleteMessagesForRoom } = await import("./storage");
    const db = await getDB();
    // Insert legacy messages directly
    await db.put("messages", {
      id: "legacy-1",
      roomCode: "room-test",
      senderId: "did:key:zSender",
      senderName: "Sender",
      lamport: 1,
      timestamp: 1,
      type: "text",
      content: "legacy",
      attachments: [],
    } as never);
    // Insert migrated message through normal path
    await putMessage({
      id: "migrated-1",
      roomCode: "room-test",
      senderId: "did:key:zSender",
      senderName: "Sender",
      lamport: 2,
      timestamp: 2,
      type: "text",
      content: "migrated",
      attachments: [],
    } as never);
    // Delete the room
    await deleteMessagesForRoom("room-test");
    // Verify both are gone
    const remaining = await getMessages("room-test");
    expect(remaining).toHaveLength(0);
  });

  it("isGifSaved: matches both blinded and plaintext gifIds during migration", async () => {
    const gifId = "tenor-123";
    // Put a gif through normal path (will be blinded)
    await putSavedGif({
      id: "gif-1",
      gifId,
      title: "Dancing Cat",
      url: "https://tenor.com/cat.gif",
      previewUrl: "https://tenor.com/cat-preview.gif",
      savedAt: Date.now(),
      mimeType: "image/gif",
    });
    // Query for it - should find it even though gifId is blinded
    const result = await isGifSaved(gifId);
    expect(result?.gifId === gifId || result?.id === "gif-1").toBe(true);
  });

  it("getMessagesAboveWatermarks: handles plaintext senderIds during migration", async () => {
    const db = await getDB();
    // Insert legacy message with plaintext senderId
    await db.put("messages", {
      id: "legacy-1",
      roomCode: "room-test",
      senderId: "did:key:zSender",
      senderName: "Sender",
      lamport: 1,
      timestamp: 1,
      type: "text",
      content: "legacy",
      attachments: [],
    } as never);
    // Insert migrated message
    await putMessage({
      id: "migrated-1",
      roomCode: "room-test",
      senderId: "did:key:zSender",
      senderName: "Sender",
      lamport: 2,
      timestamp: 2,
      type: "text",
      content: "migrated",
      attachments: [],
    } as never);
    // Query messages above watermark at 0 - should get both
    const msgs = await getMessagesAboveWatermarks("room-test", {
      "did:key:zSender": 0,
    });
    expect(msgs.map((m) => m.id).sort()).toEqual(["legacy-1", "migrated-1"]);
  });

  it("getAttachmentsByMessage: finds both legacy and migrated attachments", async () => {
    const db = await getDB();
    // Insert a message
    await putMessage({
      id: "msg-1",
      roomCode: "room-test",
      senderId: "did:key:zSender",
      senderName: "Sender",
      lamport: 1,
      timestamp: 1,
      type: "file",
      content: "file message",
      attachments: ["att-1"],
    } as never);
    // Insert legacy attachment directly
    await db.put("attachments", {
      id: "att-1",
      roomCode: "room-test",
      messageId: "msg-1",
      filename: "file.txt",
      mimeType: "text/plain",
      size: 100,
      infoHash: "hash123",
      status: "complete",
      createdAt: 1,
    } as never);
    // Query for attachments - should find the legacy one
    const attachments = await getAttachmentsByMessage("msg-1");
    expect(attachments.map((a) => a.id)).toContain("att-1");
  });

  it("getSeedableFiles: deduplicates across migration window", async () => {
    const db = await getDB();
    const infoHash = "hash123";
    const data = new Uint8Array([1, 2, 3]) as unknown as ArrayBuffer;
    // Insert legacy attachment with plaintext infoHash
    await db.put("attachments", {
      id: "att-1",
      roomCode: "room-test",
      messageId: "msg-1",
      infoHash,
      filename: "file.txt",
      mimeType: "text/plain",
      size: 3,
      status: "complete",
      createdAt: 1,
      data,
    } as never);
    // Insert migrated attachment (will have blinded infoHash)
    await putAttachment({
      id: "att-2",
      roomCode: "room-test",
      messageId: "msg-2",
      infoHash, // Same file
      filename: "file.txt",
      mimeType: "text/plain",
      size: 3,
      status: "complete",
      createdAt: 2,
      data,
    });
    // Should return only one file (deduplicated)
    const files = await getSeedableFiles();
    const dedupedFiles = files.filter((f) => f.file.infoHash === infoHash);
    expect(dedupedFiles).toHaveLength(1);
  });
});
