/**
 * Applying a backup or a device-sync export to local storage.
 *
 * Split out of sync.svelte.ts because none of it touches the transport: that
 * file constructs a libp2p node at import time, which made the restore path -
 * the one people reach for after losing a device - impossible to test.
 */
import {
  getDB,
  wipeLocalDatabase,
  putIdentityRecord,
  bulkPutMessages,
  putAttachment,
  putRoom,
  putPeerProfile,
  putOwnProfile,
  putSavedGif,
  getRoom,
  setWatermark,
  getOwnProfile,
  getPeerProfile,
  markAtRestSweepNeeded,
} from "../storage";
import type { Message, Attachment, PendingMessage } from "../types/message";
import {
  beginPlaintextImport,
  clearStorageCrypto,
  sealRow,
  storageCryptoReady,
  STORE_SPECS,
} from "../storage-crypto";
import type {
  Room,
  DMRoom,
  PeerProfile,
  OwnProfile,
  SavedGif,
  WatermarkRecord,
} from "../storage";
import {
  bytesFromExport,
  mergeImportedRoom,
  parseBackup,
  pfpFromJson,
  type AttachmentExport,
  type BackupFile,
  type DatabaseExport,
} from "./backup";

export async function importDatabase(
  data: DatabaseExport,
  mode: "add" | "replace" = "replace"
): Promise<void> {
  console.log(`[Sync] Importing database in ${mode} mode`);

  if (mode === "replace") {
    // Clear existing data first
    console.log("[Sync] Wiping local database (replace mode)");
    await wipeLocalDatabase();
    // Replace mode installs a possibly DIFFERENT identity. Sealing the
    // imported rows with the currently armed key would brick them for the
    // identity that owns them, so drop the key: the rows land plaintext and
    // the first unlock as the RIGHT identity derives the right key and
    // sweeps them sealed. (DataSettings reloads after a replace restore, so
    // the stale session never touches storage again.)
    clearStorageCrypto();
  }
  // A fresh sync target has never unlocked, so no at-rest key exists yet -
  // there is nothing to derive it from until the user types their password.
  // Inside this window sealRow passes rows through as plaintext instead of
  // throwing, and the sweep flag makes the first unlock seal all of it.
  const endPlaintextImport = beginPlaintextImport();
  // Unconditionally. Replace mode has already dropped the key above, so this
  // was equivalent in practice, but the sweep flag is what stands between an
  // import's plaintext rows and permanence: if any future path here writes
  // while a key IS armed, arming the sweep must not depend on a condition that
  // happens to be true today.
  markAtRestSweepNeeded();
  try {
    await importDatabaseInner(data, mode);
  } finally {
    endPlaintextImport();
  }
}

async function importDatabaseInner(
  data: DatabaseExport,
  mode: "add" | "replace"
): Promise<void> {

  // Import identity only if provided (not provided in "add" mode)
  if (data.identity) {
    console.log("[Sync] Importing identity");
    const mnemonicRecord = {
      id: "mnemonic" as const,
      salt: new Uint8Array(data.identity.mnemonic.salt),
      iv: new Uint8Array(data.identity.mnemonic.iv),
      encrypted: new Uint8Array(data.identity.mnemonic.encrypted).buffer,
      // Absent = written before per-record counts existed = legacy 100k,
      // which is exactly what unlockIdentity assumes when it is undefined.
      ...(typeof data.identity.mnemonic.iterations === "number"
        ? { iterations: data.identity.mnemonic.iterations }
        : {}),
    };

    const keypairRecord = {
      id: "keypair" as const,
      did: data.identity.keypair.did,
      publicKey: new Uint8Array(data.identity.keypair.publicKey),
    };

    await putIdentityRecord(mnemonicRecord);
    await putIdentityRecord(keypairRecord);
  }

  // Import other data
  console.log(
    `[Sync] Importing ${data.messages.length} messages, ${data.rooms.length} rooms, etc.`
  );
  // One transaction for the messages rather than one per message: a device
  // sync carries the whole history, and hundreds of independent transactions
  // are both slower and able to leave the database half-imported if one fails.
  await bulkPutMessages(data.messages);
  await Promise.all([
    ...data.attachments.map((a) =>
      putAttachment({
        ...a,
        data: bytesFromExport(a.data),
      } as Attachment)
    ),
    ...data.rooms.map((r) => {
      const importedRoom = pfpFromJson(r);
      if (mode === "add") {
        return (async () => {
          const localRoom = await getRoom(importedRoom.roomCode);
          if (localRoom) {
            await putRoom(mergeImportedRoom(localRoom, importedRoom));
          } else {
            await putRoom(importedRoom);
          }
        })();
      } else {
        return putRoom(importedRoom);
      }
    }),
    ...data.profiles.map((raw) => {
      const importedProfile = pfpFromJson(raw);
      if (mode === "add") {
        return (async () => {
          if (importedProfile.isMe) {
            const localProfile = await getOwnProfile();
            const importedUpdatedAt = (importedProfile as OwnProfile).updatedAt ?? 0;
            const localUpdatedAt = (localProfile as OwnProfile | undefined)?.updatedAt ?? 0;
            if (importedUpdatedAt >= localUpdatedAt) {
              await putOwnProfile(importedProfile as OwnProfile);
            }
          } else {
            const localProfile = await getPeerProfile(importedProfile.did);
            const importedUpdatedAt = (importedProfile as PeerProfile).updatedAt ?? 0;
            const localUpdatedAt = (localProfile as PeerProfile | undefined)?.updatedAt ?? 0;
            if (importedUpdatedAt >= localUpdatedAt) {
              await putPeerProfile(importedProfile as PeerProfile);
            }
          }
        })();
      } else {
        if (importedProfile.isMe) {
          return putOwnProfile(importedProfile as OwnProfile);
        } else {
          return putPeerProfile(importedProfile as PeerProfile);
        }
      }
    }),
    ...data.savedGifs.map((g) =>
      putSavedGif({
        ...g,
        data: bytesFromExport(
          g.data as unknown as string | number[] | undefined
        ),
      })
    ),
    ...data.pending.map((p) => {
      return (async () => {
        const db = await getDB();
        await db.put(
          "pending",
          (await sealRow(
            p as unknown as Record<string, unknown>,
            STORE_SPECS.pending
          )) as unknown as PendingMessage
        );
      })();
    }),
    ...data.watermarks.map((w) => {
      if (mode === "add") {
        return setWatermark(w.roomCode, w.senderId, w.maxLamport);
      } else {
        return (async () => {
          const db = await getDB();
          // Through sealRow like every other store here. In replace mode the
          // key has just been dropped, so this passes the row through
          // plaintext exactly as the others do and the sweep seals it on the
          // first unlock - but going through sealRow rather than putting raw
          // keeps that a property of ONE place, so a future change that arms a
          // key before the import does not silently leave this store behind.
          await db.put(
            "watermarks",
            (await sealRow(
              w as unknown as Record<string, unknown>,
              STORE_SPECS.watermarks
            )) as unknown as WatermarkRecord
          );
        })();
      }
    }),
    ...data.yjsDocs.map((doc) => {
      return (async () => {
        const db = await getDB();
        await db.put(
          "yjsDocs",
          (await sealRow(
            { id: doc.id, update: new Uint8Array(doc.update) },
            STORE_SPECS.yjsDocs
          )) as unknown as { id: string; update: Uint8Array }
        );
      })();
    }),
  ]);
}

// ── File backup (QR-less alternative to device sync) ─────────────────────────

/**
 * Parse and validate a backup file chosen by the user.
 * @throws if the file is not a backup this build understands.
 */
export async function readBackupFile(file: File): Promise<BackupFile> {
  return parseBackup(await file.text());
}

/**
 * Apply a parsed backup.
 * "add" merges into the current identity; "replace" wipes local data first and
 * adopts the identity stored in the file (you then unlock with the password
 * that was in use when the backup was taken).
 */
export async function applyBackup(
  data: BackupFile,
  mode: "add" | "replace"
): Promise<void> {
  if (mode === "replace" && !data.identity) {
    throw new Error("This backup has no identity, so it cannot replace yours");
  }
  await importDatabase(
    mode === "add" ? { ...data, identity: undefined } : data,
    mode
  );
}

/**
 * Start camera scanning for QR codes.
 */
