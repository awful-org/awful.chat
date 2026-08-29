import { beforeEach, describe, expect, it } from "vitest";
import { applyBackup } from "./backup-restore";
import { BACKUP_FORMAT, BACKUP_VERSION, type BackupFile } from "./backup";
import {
  getAllMessages,
  getAllRooms,
  getDB,
  getKeypairRecord,
  getMnemonicRecord,
  getWatermark,
  migrateAtRest,
  setAtRestOwner,
  wipeLocalDatabase,
} from "../storage";
import {
  createIdentity,
  isUnlocked,
  lockIdentity,
  unlockIdentity,
} from "../identity/identity";

const PASSWORD = "the password that was in use at backup time";

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
