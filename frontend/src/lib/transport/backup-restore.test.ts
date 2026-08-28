import { beforeEach, describe, expect, it } from "vitest";
import { applyBackup } from "./backup-restore";
import { BACKUP_FORMAT, BACKUP_VERSION, type BackupFile } from "./backup";
import {
  getAllRooms,
  getDB,
  getKeypairRecord,
  getMnemonicRecord,
  getWatermark,
  migrateAtRest,
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
