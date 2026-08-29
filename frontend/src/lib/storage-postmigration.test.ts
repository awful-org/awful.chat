import { beforeEach, describe, expect, it } from "vitest";
import {
  getDB, putRoom, getRoom, markRoomSeen,
  putAttachment, getAttachmentsByMessage, getAttachmentsByInfoHash,
  putSavedGif, isGifSaved,
  putPhonebookEntry, deletePhonebookEntry, getPhonebookEntries,
  putMessage, deleteMessagesForRoom, getAllMessages,
} from "./storage";
import { initStorageCrypto } from "./storage-crypto";

/**
 * The steady state AFTER migration finishes, which is where the original round
 * of blind-index bugs lived: lookups that passed a raw value into a blinded
 * index or key. They returned nothing, silently - a removed contact came back,
 * a saved gif read as unsaved, attachments were never found so duplicates
 * accumulated. None of it threw, and the migration-window tests did not catch
 * it because they seed LEGACY rows, which those broken paths still matched.
 */
// Everything here goes in through the NORMAL write path, so every row is
// sealed and blinded - the steady state after migration finishes. The original
// bugs were blinded-index lookups performed with RAW values, which return
// nothing precisely in this state.
describe("post-migration steady state", () => {
  beforeEach(async () => {
    await initStorageCrypto(
      crypto.getRandomValues(new Uint8Array(32)) as Uint8Array<ArrayBuffer>
    );
    const db = await getDB();
    for (const s of ["messages", "rooms", "attachments", "savedGifs", "phonebook"] as const) {
      await db.clear(s);
    }
  });

  it("markRoomSeen advances a migrated room", async () => {
    await putRoom({ roomCode: "r1", type: "text", name: "R", lastSeenLamport: 0, createdAt: 1, participants: [] } as never);
    await markRoomSeen("r1", 7);
    expect((await getRoom("r1"))?.lastSeenLamport).toBe(7);
  });

  it("getAttachmentsByMessage finds a migrated attachment", async () => {
    await putAttachment({ id: "a1", roomCode: "r1", messageId: "m1", filename: "f.png", mimeType: "image/png", size: 3, infoHash: "h1", status: "complete", createdAt: 1 } as never);
    expect((await getAttachmentsByMessage("m1")).map((a) => a.id)).toEqual(["a1"]);
    expect((await getAttachmentsByInfoHash("h1")).map((a) => a.id)).toEqual(["a1"]);
  });

  it("isGifSaved finds a migrated gif", async () => {
    await putSavedGif({ id: "g1", gifId: "klipy-42", title: "t", url: "u", previewUrl: "p", savedAt: 1 } as never);
    expect((await isGifSaved("klipy-42"))?.id).toBe("g1");
  });

  it("deletePhonebookEntry removes a migrated contact", async () => {
    await putPhonebookEntry({ peerId: "12D3KooWAbc", nickname: "N", addedAt: 1 } as never);
    expect((await getPhonebookEntries()).length).toBe(1);
    await deletePhonebookEntry("12D3KooWAbc");
    expect((await getPhonebookEntries()).length).toBe(0);
  });

  it("deleteMessagesForRoom removes migrated messages", async () => {
    await putMessage({ id: "m1", roomCode: "r1", senderId: "did:key:zA", senderName: "A", lamport: 1, timestamp: 1, type: "text", content: "hi", attachments: [] } as never);
    await deleteMessagesForRoom("r1");
    expect((await getAllMessages("r1")).length).toBe(0);
  });
});
