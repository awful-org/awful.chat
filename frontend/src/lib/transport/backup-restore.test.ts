import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { applyBackup, importDatabase, DIFFERENT_ACCOUNT_MERGE } from "./backup-restore";
import { BACKUP_FORMAT, BACKUP_VERSION, type BackupFile } from "./backup";
import {
  getAllMessages,
  getAllRooms,
  getDB,
  getKeypairRecord,
  getMessage,
  putMessage,
  getMnemonicRecord,
  getPeerProfile,
  getWatermark,
  migrateAtRest,
  putPeerProfile,
  setAtRestOwner,
  wipeLocalDatabase,
  putRoom,
  getRoom,
  putOwnRoomProfile,
  getOwnRoomProfile,
  deleteRoomProfilesForRoom,
  getRoomDeletionMarker,
  putIdentityRecord,
  deleteRoom,
} from "../storage";
import { initStorageCrypto } from "../storage-crypto";
import { deriveRoomKeys, newRoomSecret } from "../room-security/keys";
import {
  createIdentity,
  isUnlocked,
  lockIdentity,
  publicKeyToDid,
  unlockIdentity,
} from "../identity/identity";
import { ed25519 } from "@noble/curves/ed25519.js";
import { pqKeyCertificate } from "../identity/pq-identity";
import {
  getOwnProfile,
  putOwnProfile,
  getBlockEntries,
  putBlockEntry,
  getPhonebookEntries,
  putPhonebookEntry,
} from "../storage";
import { hashRef } from "../storage-crypto";
import { signMessage } from "../messaging";
import { newMessageId } from "../message-id";
import { isBlockedDid, dmRefusedAt } from "../blocks.svelte";
import { loadAudioPrefs, saveAudioPrefs } from "./audio-prefs";
import { joinedDmCall, noteDmCallJoined } from "../dm-call-joined";
import { DM_QUEUE_KEY, loadQueuedDmMessages, saveQueuedDmMessages } from "./dm-queue";
import type { DatabaseExport } from "./backup";

const PASSWORD = "the password that was in use at backup time";

describe("room profile import", () => {
  const secret = newRoomSecret();
  const code = deriveRoomKeys(secret).discoveryId;
  const room = (generation: number) => ({ roomCode: code, roomSecret: secret, type: "text" as const,
    name: "Sync", createdAt: generation, lastSeenLamport: 0, participants: [] });
  const data = (overrides: Record<string, unknown> = {}) => ({
    messages: [], attachments: [], pending: [], watermarks: [], yjsDocs: [],
    rooms: [], profiles: [], savedGifs: [], roomProfiles: [], roomDeletions: [],
    ...overrides,
  }) as unknown as import("./backup").DatabaseExport;

  beforeEach(async () => {
    await wipeLocalDatabase();
    await initStorageCrypto(new Uint8Array(32).fill(24));
    // Imports keep only this identity's own overrides.
    await putIdentityRecord({ id: "keypair", did: "did:alice", publicKey: new Uint8Array(32) } as never);
  });

  it("drops another identity's overrides and sanitizes the values it keeps", async () => {
    await importDatabase(data({ rooms: [room(100)], roomProfiles: [
      { roomCode: code, did: "did:mallory", generation: 100, fields: { nickname: "Not me" } },
      { roomCode: code, did: "did:alice", generation: 100, fields: {
        color: "red;background:url(https://x/beacon);position:fixed",
        tagChipColor: "#12345g", nickname: "  Alice  ", bio: null,
        pfpData: btoa("x".repeat(600 * 1024)),
      } },
    ] }), "add");
    expect(await getOwnRoomProfile(code, "did:mallory")).toBeUndefined();
    const fields = (await getOwnRoomProfile(code, "did:alice"))?.fields;
    expect(fields?.color).toBeUndefined();
    expect(fields?.tagChipColor).toBeUndefined();
    expect(fields?.pfpData).toBeUndefined();
    expect(fields?.nickname).toBe("Alice");
    expect(fields?.bio).toBeNull();
  });

  it("refuses a leave marker dated far in the future", async () => {
    await importDatabase(data({ roomDeletions: [{ roomCode: code, generation: 9e15, deletedAt: 9e15 }] }), "add");
    expect(await getRoomDeletionMarker(code)).toBeUndefined();
    await putRoom(room(100));
    expect((await getRoom(code))?.createdAt).toBe(100);
  });

  it("restores a room override on a second device and merges independent field edits", async () => {
    await importDatabase(data({ rooms: [room(100)], roomProfiles: [{
      roomCode: code, did: "did:alice", generation: 100,
      fields: { nickname: "Room Alice" },
      fieldEdits: { nickname: { at: 110, id: "device-a" } },
    }] }), "add");
    expect((await getOwnRoomProfile(code, "did:alice"))?.fields.nickname).toBe("Room Alice");
    await importDatabase(data({ roomProfiles: [{
      roomCode: code, did: "did:alice", generation: 100,
      fields: { bio: "Hello" }, fieldEdits: { bio: { at: 120, id: "device-b" } },
    }] }), "add");
    expect((await getOwnRoomProfile(code, "did:alice"))?.fields).toEqual({ nickname: "Room Alice", bio: "Hello" });
  });

  it("applies later reset tombstones and keeps a newer rejoin generation", async () => {
    await putRoom(room(200));
    await putOwnRoomProfile({ roomCode: code, did: "did:alice", generation: 200,
      fields: { nickname: "Old", bio: "Local" },
      fieldEdits: { nickname: { at: 201, id: "a" }, bio: { at: 202, id: "a" } } });
    await importDatabase(data({ rooms: [room(100)], roomProfiles: [{
      roomCode: code, did: "did:alice", generation: 200,
      fields: { bio: null }, fieldEdits: { nickname: { at: 203, id: "b", reset: true },
        bio: { at: 204, id: "b" } },
    }] }), "add");
    expect((await getRoom(code))?.createdAt).toBe(200);
    expect((await getOwnRoomProfile(code, "did:alice"))?.fields).toEqual({ bio: null });
  });

  it("never removes a room or its history for a leave on another device", async () => {
    await putRoom(room(100));
    await putOwnRoomProfile({ roomCode: code, did: "did:alice", generation: 100,
      fields: { nickname: "Kept" } });
    await importDatabase(data({ roomDeletions: [{ roomCode: code, generation: 150, deletedAt: 151 }] }), "add");
    // Still in the generation the marker names: nothing changes here.
    expect((await getRoom(code))?.createdAt).toBe(100);
    expect((await getOwnRoomProfile(code, "did:alice"))?.fields.nickname).toBe("Kept");
    expect(await getRoomDeletionMarker(code)).toBeUndefined();
  });

  it("keeps a left generation's overrides out when an old snapshot brings the room back", async () => {
    await importDatabase(data({ roomDeletions: [{ roomCode: code, generation: 150, deletedAt: 151 }] }), "add");
    expect((await getRoomDeletionMarker(code))?.generation).toBe(150);
    await importDatabase(data({ rooms: [room(100)], roomProfiles: [{
      roomCode: code, did: "did:alice", generation: 100,
      fields: { nickname: "Stale" },
    }] }), "add");
    // The room is back - as a new generation above the marker, so its
    // profiles can be written - but the left generation's override is not.
    expect((await getRoom(code))?.createdAt).toBe(152);
    expect(await getOwnRoomProfile(code, "did:alice")).toBeUndefined();
  });

  it("normalizes independent joins, then applies a later leave without refreshing its timestamp", async () => {
    await putRoom(room(200));
    await importDatabase(data({ rooms: [room(100)], roomProfiles: [{
      roomCode: code, did: "did:alice", generation: 100,
      fields: { nickname: "Joined on A", pfpData: btoa("image") },
      fieldEdits: { nickname: { at: 110, id: "a" } },
    }] }), "add");
    const imported = await getOwnRoomProfile(code, "did:alice");
    expect(imported?.generation).toBe(200);
    expect(imported?.fields.nickname).toBe("Joined on A");
    expect([...new Uint8Array(imported?.fields.pfpData as ArrayBuffer)]).toEqual([...new TextEncoder().encode("image")]);
    await importDatabase(data({ rooms: [room(100)], roomDeletions: [{
      roomCode: code, generation: 100, deletedAt: 300,
    }] }), "add");
    // A leave elsewhere: this device is still in the room, so it stays.
    expect((await getRoom(code))?.createdAt).toBe(200);
    expect(await getRoomDeletionMarker(code)).toBeUndefined();
    await deleteRoomProfilesForRoom(code, 100, 300);
    await deleteRoom(code);
    await putRoom(room(400));
    await importDatabase(data({ roomDeletions: [{
      roomCode: code, generation: 100, deletedAt: 300,
    }] }), "add");
    expect((await getRoom(code))?.createdAt).toBe(400);
    expect((await getRoomDeletionMarker(code))?.deletedAt).toBe(300);
  });

  it("keeps a remote marker alongside a later rejoin and rejects a subsequent old snapshot", async () => {
    await putRoom(room(400));
    await putOwnRoomProfile({ roomCode: code, did: "did:alice", generation: 400,
      fields: { nickname: "Rejoined" } });
    await importDatabase(data({ roomDeletions: [{ roomCode: code, generation: 100, deletedAt: 300 }] }), "add");
    expect((await getRoomDeletionMarker(code))?.deletedAt).toBe(300);
    expect((await getOwnRoomProfile(code, "did:alice"))?.fields.nickname).toBe("Rejoined");
    await importDatabase(data({ rooms: [room(200)], roomProfiles: [{
      roomCode: code, did: "did:alice", generation: 200, fields: { nickname: "Stale" },
    }] }), "add");
    expect((await getRoom(code))?.createdAt).toBe(400);
    expect((await getOwnRoomProfile(code, "did:alice"))?.fields.nickname).toBe("Rejoined");
  });

  it("retains a local override when another device contributes a newer join generation", async () => {
    await putRoom(room(100));
    await putOwnRoomProfile({ roomCode: code, did: "did:alice", generation: 100,
      fields: { nickname: "Local" }, fieldEdits: { nickname: { at: 110, id: "a" } } });
    await importDatabase(data({ rooms: [room(200)], roomProfiles: [{
      roomCode: code, did: "did:alice", generation: 200,
      fields: { bio: "Remote" }, fieldEdits: { bio: { at: 210, id: "b" } },
    }] }), "add");
    expect((await getOwnRoomProfile(code, "did:alice"))?.generation).toBe(200);
    expect((await getOwnRoomProfile(code, "did:alice"))?.fields).toEqual({ nickname: "Local", bio: "Remote" });
  });

  it("clears profile rows on a local leave even if a newer marker already exists", async () => {
    await putRoom(room(400));
    await importDatabase(data({ roomDeletions: [{ roomCode: code, generation: 100, deletedAt: 300 }] }), "add");
    await putOwnRoomProfile({ roomCode: code, did: "did:alice", generation: 400,
      fields: { nickname: "Later" } });
    await deleteRoomProfilesForRoom(code, 100, 200);
    expect(await getOwnRoomProfile(code, "did:alice")).toBeUndefined();
    expect((await getRoomDeletionMarker(code))?.deletedAt).toBe(300);
  });
});

/** A backup taken by an identity that no longer exists on this device. */
async function backupFromAnIdentity(): Promise<BackupFile> {
  await wipeLocalDatabase();
  const { keypair } = await createIdentity(PASSWORD);
  const mnemonic = await getMnemonicRecord();
  if (!mnemonic) throw new Error("no mnemonic record");
  return {
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: 1_700_000_000_000,
    identity: {
      mnemonic: {
        salt: Array.from(mnemonic.salt),
        iv: Array.from(mnemonic.iv),
        encrypted: Array.from(new Uint8Array(mnemonic.encrypted)),
        iterations: mnemonic.iterations,
      },
      keypair: {
        did: keypair.did,
        publicKey: Array.from(keypair.publicKey),
      },
    },
    messages: [],
    attachments: [],
    pending: [],
    watermarks: [],
    yjsDocs: [],
    rooms: [
      {
        roomCode: "restoredroom0001",
        type: "text",
        name: "A room from the backup",
        lastSeenLamport: 0,
        createdAt: 1,
        participants: [],
      },
    ],
    profiles: [],
    savedGifs: [],
  } as unknown as BackupFile;
}

// The setup screen offered only "create" and "restore from phrase"; the backup
// importer lived in Settings, which needs an unlocked identity. So a backup
// could not be used in the one situation it exists for - an empty device, or a
// lost recovery phrase. This is the path that flow now takes.
describe("restoring a backup onto a device with no identity", () => {
  let backup: BackupFile;

  beforeEach(async () => {
    backup = await backupFromAnIdentity();
    // A genuinely fresh install: no identity, storage locked.
    await wipeLocalDatabase();
    lockIdentity();
  });

  it("installs the identity from the file", async () => {
    expect(await getKeypairRecord()).toBeUndefined();

    await applyBackup(backup, "replace");

    const restored = await getKeypairRecord();
    expect(restored?.did).toBe(backup.identity?.keypair.did);
  });

  it("checks cancellation after password derivation before activating or writing an identity", async () => {
    let checked = false;
    await expect(applyBackup(backup, "replace", {
      requestPassword: async () => PASSWORD,
      beforeCommit: () => {
        checked = true;
        expect(isUnlocked()).toBe(false);
        throw new Error("Cancelled session");
      },
    })).rejects.toThrow("Cancelled session");
    expect(checked).toBe(true);
    expect(isUnlocked()).toBe(false);
    expect(await getKeypairRecord()).toBeUndefined();
    expect(await getMnemonicRecord()).toBeUndefined();
    expect(await getAllRooms()).toEqual([]);
  });

  it("restores the data, which a recovery phrase alone cannot", async () => {
    await applyBackup(backup, "replace");
    // Import runs with storage locked, so rows land plaintext and the first
    // unlock seals them - either way the room has to be readable.
    const rooms = await getAllRooms();
    expect(rooms.map((r) => r.roomCode)).toContain("restoredroom0001");
  });

  it("unlocks with the password that was in use when the backup was taken", async () => {
    await applyBackup(backup, "replace");
    // unlockIdentity returns void and THROWS on a wrong password, so the
    // assertion is that the right one resolves and the wrong one does not.
    await expect(unlockIdentity(PASSWORD)).resolves.toBeUndefined();
    expect(isUnlocked()).toBe(true);

    lockIdentity();
    await expect(unlockIdentity("not the backup password")).rejects.toThrow();
  });

  it("refuses a backup with no identity, which cannot start a device", async () => {
    const { identity: _dropped, ...noIdentity } = backup;
    await expect(
      applyBackup(noIdentity as BackupFile, "replace")
    ).rejects.toThrow(/identity/i);
  });
});

// A restore lands rows plaintext on purpose: replace mode drops the at-rest key
// first, because the backup may belong to a DIFFERENT identity and sealing with
// the current key would brick it. What makes that safe is the sweep flag - the
// first unlock as the right identity seals everything. This pins the end of
// that chain: after a restore and a sweep, no room code and no sender DID
// survives in readable form, including inside the "roomCode:senderId" primary
// key of the watermarks store.
describe("a restore must not undo at-rest protection", () => {
  it("seals restored watermarks instead of writing them in the clear", async () => {
    const backup = await backupFromAnIdentity();
    const withWatermarks = {
      ...backup,
      watermarks: [
        {
          id: "beefcafe12345678:did:key:zAlice",
          roomCode: "beefcafe12345678",
          senderId: "did:key:zAlice",
          maxLamport: 4,
        },
      ],
    } as unknown as BackupFile;

    await applyBackup(withWatermarks, "replace");
    await unlockIdentity(PASSWORD);
    // The app fires the sweep on unlock but does not await it, so the rows an
    // import wrote stay plaintext for a moment by design. Await it here: what
    // matters is that the sweep is still ARMED after a restore and does reach
    // these rows, which is exactly what breaks when the flag is left set.
    // The unlock already kicked off a sweep, so a second call hits the
    // in-progress guard and returns at once. Poll for the real completion.
    for (let i = 0; i < 60; i++) {
      await migrateAtRest();
      const rows = await (await getDB()).getAll("watermarks");
      if (rows.length && !JSON.stringify(rows).includes("beefcafe12345678")) break;
      await new Promise((r) => setTimeout(r, 50));
    }

    const db = await getDB();
    const raw = JSON.stringify({
      keys: await db.getAllKeys("watermarks"),
      rows: await db.getAll("watermarks"),
    });
    // The room code is the membership secret; the senderId is the social graph.
    expect(raw).not.toContain("beefcafe12345678");
    expect(raw).not.toContain("did:key:zAlice");

    // ...and the restored counter still has to work.
    expect(await getWatermark("beefcafe12345678", "did:key:zAlice")).toBe(4);
  });
});

// The sweep flag is identity-scoped. A restore from the signup screen runs
// before any identity is active, so the scoped key it would clear is not the
// key the sweep checks after unlock. On a device that had already migrated
// that identity, "done" stayed set over freshly imported plaintext rows: the
// sweep early-returned, and because isMigrationComplete() then suppressed the
// dual read, every imported message was invisible. Rooms still listed, which
// made it look like a partial import rather than a read failure.
describe("a restore must re-arm the sweep for the identity that unlocks", () => {
  it("clears the flag for every identity, not just the active one", async () => {
    // This environment has no localStorage, and storage.ts wraps every access
    // in try/catch, so without a stub the flag path is never exercised at all.
    const store = new Map<string, string>();
    (globalThis as Record<string, unknown>).localStorage = {
      getItem: (k: string) => store.get(k) ?? null,
      setItem: (k: string, v: string) => void store.set(k, v),
      removeItem: (k: string) => void store.delete(k),
      clear: () => store.clear(),
      key: (i: number) => Array.from(store.keys())[i] ?? null,
      get length() {
        return store.size;
      },
    };

    const backup = await backupFromAnIdentity();
    const did = backup.identity!.keypair.did;

    // This device already finished a sweep for that identity.
    localStorage.setItem(`awful:atrest:v2:${did}`, String(Date.now()));
    localStorage.setItem("awful:atrest:v2", String(Date.now()));

    // Restoring happens with NO identity active, exactly as on the signup
    // screen. Without this the module still holds the owner set by
    // createIdentity above, the scoped key and the unscoped key collapse to
    // the same string, and the bug cannot reproduce.
    setAtRestOwner(null);
    await applyBackup(backup, "replace");

    const stale = Array.from(store.keys()).filter((k) =>
      k.startsWith("awful:atrest")
    );
    expect(stale).toEqual([]);
    delete (globalThis as Record<string, unknown>).localStorage;
  });
});

// A backup file is untrusted input: a hand-edited or truncated file, or a
// bug on the exporting device, can put per-record garbage into an otherwise
// well-formed collection. parseBackup only coerces the collection itself to
// an array - the per-record check lives in sanitizeCollections (backup.ts)
// and applyBackup is what wires it in, so this pins that wiring rather than
// re-testing the validator's own rules (see backup.test.ts for those).
describe("applyBackup drops malformed records instead of importing them", () => {
  it("keeps a well-formed message and drops a malformed one, reporting the count", async () => {
    const backup = await backupFromAnIdentity();
    const withMessages = {
      ...backup,
      messages: [
        {
          id: "good-message",
          roomCode: "restoredroom0001",
          senderId: "did:key:zAlice",
          senderName: "Alice",
          timestamp: 1,
          lamport: 1,
          type: "text",
          content: "hello from the backup",
          attachments: [],
        },
        // Missing roomCode/senderId and an unknown type - must not reach storage.
        { id: "bad-message", type: "not_a_real_type", lamport: 1 },
      ],
    } as unknown as BackupFile;

    const result = await applyBackup(withMessages, "replace");
    expect(result.droppedRecords).toBe(1);

    // Import runs with storage locked (see the restore-onto-a-fresh-device
    // tests above); reading messages back needs the at-rest key.
    await unlockIdentity(PASSWORD);
    const stored = await getAllMessages("restoredroom0001");
    expect(stored.map((m) => m.id)).toEqual(["good-message"]);
  });

  it("reports zero dropped records for an already well-formed backup", async () => {
    const backup = await backupFromAnIdentity();
    const result = await applyBackup(backup, "replace");
    expect(result.droppedRecords).toBe(0);
  });
});

// "Merge" is supposed to keep this device's account and fold the other
// device's history in. The importer wrote whatever identity section it was
// handed, and the device-sync target forwarded one in every mode - so a merge
// silently replaced the identity, and the device it merged onto woke up as
// somebody else's account.
describe("a merge never adopts the incoming identity", () => {
  it("keeps this device's identity records untouched in add mode", async () => {
    const incoming = await backupFromAnIdentity();

    await wipeLocalDatabase();
    const { keypair: mine } = await createIdentity("my own password");
    const mnemonicBefore = await getMnemonicRecord();

    await applyBackup(incoming, "add");

    expect((await getKeypairRecord())?.did).toBe(mine.did);
    expect(mine.did).not.toBe(incoming.identity?.keypair.did);
    const mnemonicAfter = await getMnemonicRecord();
    expect(Array.from(new Uint8Array(mnemonicAfter!.encrypted))).toEqual(
      Array.from(new Uint8Array(mnemonicBefore!.encrypted))
    );

    // ...and the data it came for still merged in.
    expect((await getAllRooms()).map((r) => r.roomCode)).toContain(
      "restoredroom0001"
    );
  });
});

// The identity section is part of a file someone may have handed over
// (security audit L3).
describe("a backup's identity section is checked before it is trusted", () => {
  it("refuses an iteration count no build ever wrote, which made unlocking spin", async () => {
    const backup = await backupFromAnIdentity();
    backup.identity!.mnemonic.iterations = 4_000_000_000;
    await wipeLocalDatabase();
    await expect(applyBackup(backup, "replace")).rejects.toThrow("Invalid backup");
    expect(await getKeypairRecord()).toBeUndefined();
  });

  it("refuses a keypair whose public key is not its DID's", async () => {
    const backup = await backupFromAnIdentity();
    backup.identity!.keypair.did = publicKeyToDid(ed25519.getPublicKey(new Uint8Array(32).fill(7)));
    await wipeLocalDatabase();
    await expect(applyBackup(backup, "replace")).rejects.toThrow("does not match its DID");
    expect(await getKeypairRecord()).toBeUndefined();
  });
});

// A merged-in file could reuse a real message's id to replace it with forged
// content under anyone's name (security audit M4).
describe("a merge never overwrites or forges messages", () => {
  it("keeps a message already held, drops a bad signature, adds genuinely new rows", async () => {
    const incoming = await backupFromAnIdentity();
    await wipeLocalDatabase();
    await createIdentity("my own password");
    const row = (id: string, content: string, extra: Record<string, unknown> = {}) => ({
      id, roomCode: "restoredroom0001", senderId: "did:key:zBob", senderName: "Bob",
      timestamp: 1, lamport: 1, type: "text", content, attachments: [], ...extra,
    });
    await putMessage(row("m-1", "the real message") as never);

    await applyBackup({
      ...incoming,
      messages: [
        row("m-1", "forged"),
        row("m-2", "new and unsigned, in a DM", { roomCode: "dm-restoredconversation" }),
        row("m-3", "forged with a bad signature", { senderDid: "did:key:zBob", sig: "00".repeat(64), sigV: 3 }),
      ],
    } as unknown as BackupFile, "add");

    expect((await getMessage("m-1"))?.content).toBe("the real message");
    expect((await getMessage("m-2"))?.content).toBe("new and unsigned, in a DM");
    expect(await getMessage("m-3")).toBeUndefined();
  });
});

// A peer's PQ key certificate is what lets this device seal for them
// post-quantum while they are offline. A merged-in profile row from a device
// that never heard it is usually NEWER (it saw their name change later), and
// taking it wholesale quietly downgraded every message sealed to them.
describe("a merge keeps a peer's post-quantum key", () => {
  it("keeps the local certificate when a newer imported row has none", async () => {
    const incoming = await backupFromAnIdentity();
    await wipeLocalDatabase();
    await createIdentity("my own password");
    const peerSeed = crypto.getRandomValues(new Uint8Array(32));
    const peerDid = publicKeyToDid(ed25519.getPublicKey(peerSeed));
    const cert = pqKeyCertificate({ did: peerDid, privateKey: peerSeed });
    await putPeerProfile({ did: peerDid, isMe: false, nickname: "old", updatedAt: 1, pqKey: cert });

    await applyBackup({
      ...incoming,
      profiles: [{ did: peerDid, isMe: false, nickname: "new", updatedAt: 2 }],
    } as unknown as BackupFile, "add");

    const merged = await getPeerProfile(peerDid);
    expect(merged?.nickname).toBe("new");
    expect(merged?.pqKey).toEqual(cert);
  });
});

// The import used to write every row in the clear and rely on the first
// unlock sweeping them sealed. IndexedDB does not erase what it overwrites,
// so those plaintext rows stay recoverable on disk - which the at-rest design
// and the duress wipe both assume never happens. Fix: get the password first,
// unlock the incoming identity, and only then write.
describe("an import with an identity unlocks before it writes", () => {
  beforeEach(async () => {
    await wipeLocalDatabase();
    lockIdentity();
  });

  it("seals the imported rows on write instead of leaving them plaintext", async () => {
    const backup = await backupFromAnIdentity();
    await wipeLocalDatabase();
    lockIdentity();

    const asked: boolean[] = [];
    await applyBackup(backup, "replace", {
      requestPassword: async (retry) => {
        asked.push(retry);
        return PASSWORD;
      },
    });

    expect(asked).toEqual([false]);
    expect(isUnlocked()).toBe(true);

    // Straight to the raw store: no sweep has run, so anything readable here
    // was written in the clear.
    const raw = JSON.stringify(await (await getDB()).getAll("rooms"));
    expect(raw).not.toContain("restoredroom0001");
    expect(raw).not.toContain("A room from the backup");

    // And the row is still there, readable under the imported identity.
    expect((await getAllRooms()).map((r) => r.roomCode)).toContain(
      "restoredroom0001"
    );
  });

  it("writes nothing when the prompt is cancelled", async () => {
    const backup = await backupFromAnIdentity();
    await wipeLocalDatabase();
    lockIdentity();

    await expect(
      applyBackup(backup, "replace", { requestPassword: async () => null })
    ).rejects.toThrow(/cancelled/i);

    expect(await getKeypairRecord()).toBeUndefined();
    expect(await (await getDB()).getAll("rooms")).toEqual([]);
    expect(isUnlocked()).toBe(false);
  });

  it("asks again after a wrong password rather than importing", async () => {
    const backup = await backupFromAnIdentity();
    await wipeLocalDatabase();
    lockIdentity();

    const answers = ["not the backup password", PASSWORD];
    await applyBackup(backup, "replace", {
      requestPassword: async () => answers.shift() ?? null,
    });

    expect(answers).toEqual([]);
    expect((await getKeypairRecord())?.did).toBe(backup.identity?.keypair.did);
  });

  // A merge runs on a device that is already unlocked, so its key is armed
  // and sealRow seals as usual - nothing to prompt for, and no plaintext.
  it("needs no password for a merge, which already runs unlocked", async () => {
    const incoming = await backupFromAnIdentity();
    await wipeLocalDatabase();
    await createIdentity("my own password");

    let asked = false;
    await applyBackup(incoming, "add", {
      requestPassword: async () => {
        asked = true;
        return null;
      },
    });

    expect(asked).toBe(false);
    const raw = JSON.stringify(await (await getDB()).getAll("rooms"));
    expect(raw).not.toContain("restoredroom0001");
  });
});

/** An export holding only `overrides`, as a device sync's source sends one. */
function exportOf(overrides: Partial<DatabaseExport> = {}): DatabaseExport {
  return {
    messages: [], attachments: [], pending: [], watermarks: [], yjsDocs: [],
    rooms: [], profiles: [], savedGifs: [], roomProfiles: [], roomDeletions: [],
    ...overrides,
  } as DatabaseExport;
}

/** localStorage for one test: the suite has none, and storage.ts and the prefs modules hide that. */
function withLocalStorage(): Map<string, string> {
  const store = new Map<string, string>();
  (globalThis as Record<string, unknown>).localStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
    clear: () => store.clear(),
    key: (i: number) => Array.from(store.keys())[i] ?? null,
    get length() {
      return store.size;
    },
  };
  return store;
}

// A device sync's merge used to take whatever the QR it scanned led to:
// another account's own profile landed as this one's, and rows nothing else
// in the app would take unsigned were kept because there was no signature
// to fail.
describe("a merge is for this account's data only", () => {
  beforeEach(async () => {
    await wipeLocalDatabase();
  });

  it("refuses a merge from another account before anything is written", async () => {
    const { keypair } = await createIdentity("my own password");
    await expect(importDatabase(exportOf({
      rooms: [{ roomCode: "otheraccountroom", type: "text", name: "Theirs", lastSeenLamport: 0,
        createdAt: 1, participants: [] } as never],
    }), "add", { sourceDid: "did:key:zSomebodyElse" })).rejects.toThrow(DIFFERENT_ACCOUNT_MERGE);
    expect(await getAllRooms()).toEqual([]);
    // The same account goes through.
    await importDatabase(exportOf(), "add", { sourceDid: keypair.did });
  });

  it("writes an own profile only for this account, and never a peer row over it", async () => {
    const { keypair } = await createIdentity("my own password");
    await putOwnProfile({ did: keypair.did, isMe: true, nickname: "Me", updatedAt: 10 });
    await importDatabase(exportOf({ profiles: [
      { did: "did:key:zSomebodyElse", isMe: true, nickname: "Not me", updatedAt: 99 },
      { did: keypair.did, isMe: false, nickname: "A cached copy of me", updatedAt: 99 },
    ] as never }), "add");
    expect((await getOwnProfile())?.nickname).toBe("Me");
    expect(await getPeerProfile("did:key:zSomebodyElse")).toBeUndefined();
    const rows = await (await getDB()).getAll("profiles");
    expect(rows.filter((p) => p.isMe === true)).toHaveLength(1);

    await importDatabase(exportOf({ profiles: [
      { did: keypair.did, isMe: true, nickname: "Me, renamed elsewhere", updatedAt: 20 },
    ] as never }), "add");
    expect((await getOwnProfile())?.nickname).toBe("Me, renamed elsewhere");
  });

  // What a merge from another account used to leave behind: two isMe rows,
  // and "the first one" decided which was shown as us.
  it("reads our own profile under our DID when an old merge left another isMe row", async () => {
    const { keypair } = await createIdentity("my own password");
    await putOwnProfile({ did: "did:key:zSomebodyElse", isMe: true, nickname: "Not me", updatedAt: 1 });
    await putOwnProfile({ did: keypair.did, isMe: true, nickname: "Me", updatedAt: 1 });
    expect((await getOwnProfile(keypair.did))?.nickname).toBe("Me");
  });

  it("keeps unsigned rows only where history sync from a paired device would", async () => {
    const { keypair } = await createIdentity("my own password");
    const row = (id: string, extra: Record<string, unknown> = {}) => ({
      id, roomCode: "plainroom0000001", senderId: "did:key:zBob", senderName: "Bob",
      timestamp: 1, lamport: 1, type: "text", content: "x", attachments: [], ...extra,
    });
    const squatted = newMessageId("did:key:zCarol");
    const mine = signMessage(row(newMessageId(keypair.did), {
      senderId: keypair.did, content: "signed by me",
    }) as never);
    // A valid signature, from a key that is not the sender it names.
    const impostor = signMessage(row("m-impostor", { content: "my key, Bob's name" }) as never);
    await importDatabase(exportOf({ messages: [
      row("m-room-unsigned", { content: "unsigned, in a room" }),
      row("m-dm-unsigned", { roomCode: "dm-aconversation", content: "unsigned DM text" }),
      row("m-dm-file", { roomCode: "dm-aconversation", type: "file",
        meta: { files: [{ name: "a.png", size: 1, mimeType: "image/png", infoHash: "x" }] } }),
      row(squatted, { roomCode: "dm-aconversation", content: "an id bound to Carol" }),
      mine,
      impostor,
    ] as never }), "add");
    expect(await getMessage("m-room-unsigned")).toBeUndefined();
    expect((await getMessage("m-dm-unsigned"))?.content).toBe("unsigned DM text");
    expect(await getMessage("m-dm-file")).toBeUndefined();
    expect(await getMessage(squatted)).toBeUndefined();
    expect(await getMessage("m-impostor")).toBeUndefined();
    expect((await getMessage(mine.id))?.content).toBe("signed by me");
  });

  it("takes our own other device's unsigned history whole, once it proved the account", async () => {
    const { keypair } = await createIdentity("my own password");
    const row = (id: string, extra: Record<string, unknown> = {}) => ({
      id, roomCode: "plainroom0000001", senderId: "did:key:zBob", senderName: "Bob",
      timestamp: 1, lamport: 1, type: "text", content: "x", attachments: [], ...extra,
    });
    const impostor = signMessage(row("m-impostor2", { content: "my key, Bob's name" }) as never);
    await importDatabase(exportOf({ messages: [
      row("m-room-before-signing", { content: "from before signing" }),
      impostor,
    ] as never }), "add", { sourceDid: keypair.did });
    expect((await getMessage("m-room-before-signing"))?.content).toBe("from before signing");
    // A signature still has to be right.
    expect(await getMessage("m-impostor2")).toBeUndefined();
  });

  it("keeps only the installed account's own profile on a replace", async () => {
    const backup = await backupFromAnIdentity();
    const did = backup.identity!.keypair.did;
    await wipeLocalDatabase();
    lockIdentity();
    await applyBackup({ ...backup, profiles: [
      { did, isMe: true, nickname: "The restored me", updatedAt: 5 },
      { did: "did:key:zSomebodyElse", isMe: true, nickname: "Not me", updatedAt: 9 },
    ] } as unknown as BackupFile, "replace", { requestPassword: async () => PASSWORD });
    expect((await getOwnProfile())?.nickname).toBe("The restored me");
    const rows = await (await getDB()).getAll("profiles");
    expect(rows.filter((p) => p.isMe === true)).toHaveLength(1);
  });
});

// Soft blocks and the phonebook lived only in their own stores, which the
// export never read: a second device came up with every blocked person
// unblocked and an empty contact list.
describe("a merge carries blocks and contacts", () => {
  beforeEach(async () => {
    await wipeLocalDatabase();
    await createIdentity("my own password");
  });

  it("unions blocks, keeping an active block active and every refusal window, in this session too", async () => {
    await putBlockEntry({ did: "did:key:zMallory", name: "Mallory", blockedAt: 100, unblockedAt: 200 });
    await importDatabase(exportOf({ blocks: [
      { did: "did:key:zMallory", name: "Mallory", blockedAt: 300 },
      { did: "did:key:zTrent", name: "Trent", blockedAt: 50, unblockedAt: 60 },
    ] }), "add");
    const entries = new Map((await getBlockEntries()).map((e) => [e.did, e]));
    expect(entries.get("did:key:zMallory")).toEqual({
      did: "did:key:zMallory", name: "Mallory", blockedAt: 300, earlier: [[100, 200]],
    });
    expect(entries.get("did:key:zTrent")?.unblockedAt).toBe(60);
    // The session already acts on the merged list, without a reload.
    expect(isBlockedDid("did:key:zMallory")).toBe(true);
    expect(isBlockedDid("did:key:zTrent")).toBe(false);
    expect(dmRefusedAt("did:key:zTrent", 55)).toBe(true);
    expect(dmRefusedAt("did:key:zMallory", 150)).toBe(true);
  });

  it("unions the phonebook and folds one contact added in two forms into one", async () => {
    await putPhonebookEntry({ peerId: "12D3KooWBobPeerId", did: "did:key:zBob", nickname: "Bob", addedAt: 500 });
    await importDatabase(exportOf({ phonebook: [
      { peerId: "did:key:zBob", nickname: "Bob", addedAt: 100, favorite: true },
      { peerId: "did:key:zCarol", nickname: "Carol", addedAt: 200 },
    ] }), "add");
    const book = await getPhonebookEntries();
    expect(book).toHaveLength(2);
    expect(book.find((e) => e.did === "did:key:zBob")).toMatchObject({
      peerId: "12D3KooWBobPeerId", addedAt: 100, favorite: true,
    });
    expect(book.find((e) => e.peerId === "did:key:zCarol")?.nickname).toBe("Carol");
  });

  it("leaves both alone when the export never carried them", async () => {
    await putBlockEntry({ did: "did:key:zMallory", name: "Mallory", blockedAt: 100 });
    await putPhonebookEntry({ peerId: "did:key:zBob", nickname: "Bob", addedAt: 1 });
    await importDatabase(exportOf(), "add");
    expect(await getBlockEntries()).toHaveLength(1);
    expect(await getPhonebookEntries()).toHaveLength(1);
  });
});

describe("a merge carries the account state kept outside the database", () => {
  afterEach(() => {
    delete (globalThis as Record<string, unknown>).localStorage;
  });

  it("unions voice withholds and calls taken part in, keeping this device's volumes and devices", async () => {
    withLocalStorage();
    await wipeLocalDatabase();
    await createIdentity("my own password");
    saveAudioPrefs({ inputDevice: "this-devices-mic", peerVolumes: { "did:key:zA": 0.3 },
      voiceWithheld: ["did:key:zA"] });
    noteDmCallJoined("call-taken-here");
    await importDatabase(exportOf({ localState: {
      peerVolumes: { "did:key:zA": 2, "did:key:zB": 0.7 },
      voiceWithheld: ["did:key:zB"],
      dmCallsJoined: ["call-taken-there"],
    } }), "add");
    const prefs = loadAudioPrefs();
    expect(prefs.inputDevice).toBe("this-devices-mic");
    expect(prefs.peerVolumes).toEqual({ "did:key:zA": 0.3, "did:key:zB": 0.7 });
    expect([...prefs.voiceWithheld].sort()).toEqual(["did:key:zA", "did:key:zB"]);
    expect(joinedDmCall("call-taken-there")).toBe(true);
    expect(joinedDmCall("call-taken-here")).toBe(true);
  });

  it("merges the other device's DM retry queue into this one's", async () => {
    withLocalStorage();
    await wipeLocalDatabase();
    await createIdentity("my own password");
    // Made "on the other device": the same account derives the same at-rest
    // key, so the sealed blob opens here as it is.
    await saveQueuedDmMessages([{ to: "did:key:zBob", data: [1, 2, 3], queuedAt: 10, messageId: "queued-there" }]);
    const blob = localStorage.getItem(DM_QUEUE_KEY)!;
    expect(blob).not.toContain("zBob");
    await saveQueuedDmMessages([{ to: "did:key:zCarol", data: [4], queuedAt: 20, messageId: "queued-here" }]);
    await importDatabase(exportOf({ localState: { dmQueue: blob } }), "add");
    expect((await loadQueuedDmMessages()).map((e) => e.messageId)).toEqual(["queued-there", "queued-here"]);
  });

  // markAtRestSweepNeeded cleared every account's flag on any import, so a
  // merge into one account cost every other account on the device a full
  // re-sweep of rows nobody had touched.
  it("re-arms the sweep for this account only", async () => {
    withLocalStorage();
    await wipeLocalDatabase();
    const { keypair } = await createIdentity("my own password");
    const mine = `awful:atrest:v3:${hashRef(keypair.did)}`;
    for (let i = 0; i < 60 && localStorage.getItem(mine) === null; i++) {
      await migrateAtRest();
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(localStorage.getItem(mine)).not.toBeNull();
    localStorage.setItem("awful:atrest:v3:anotheraccount00", "1");
    await importDatabase(exportOf(), "add");
    expect(localStorage.getItem(mine)).toBeNull();
    expect(localStorage.getItem("awful:atrest:v3:anotheraccount00")).toBe("1");
  });
});
