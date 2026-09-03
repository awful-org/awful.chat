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
  parseBackupFileText,
  pfpFromJson,
  sanitizeCollections,
  type AttachmentExport,
  type BackupFile,
  type DatabaseExport,
  type ParsedBackupFile,
} from "./backup";
import { unlockWithImportedMnemonic } from "../identity/identity";
import type { MnemonicRecord } from "../identity/identity";

export interface ImportResult {
  /** Records dropped by the per-record shape/size validator (see
   * sanitizeCollections in backup.ts) across every collection - a backup or
   * device-sync export is untrusted input, and this is what a caller can
   * show the user instead of silently importing a partial dataset. */
  droppedRecords: number;
}

export interface ImportOptions {
  /**
   * Asked for the imported identity's password BEFORE anything is wiped or
   * written, so the at-rest key is armed and sealRow seals every imported row
   * on write. Return null to abort with nothing changed. `retry` is true when
   * the previous answer was rejected, so the prompt can say so instead of
   * looking like it hung.
   *
   * Without it an import carrying an identity falls back to the plaintext
   * window (beginPlaintextImport), which only stays safe because the first
   * unlock sweeps those rows sealed - and IndexedDB keeps the plaintext it
   * overwrote.
   */
  requestPassword?: (retry: boolean) => Promise<string | null>;
  /**
   * Called as records land, with a running count and the total. A device
   * sync's whole history goes through here, and on a phone that takes
   * long enough that a bar which stops moving reads as a hang.
   */
  onProgress?: (done: number, total: number) => void;
}

/** The stored mnemonic record that an export's identity section describes. */
function mnemonicRecordFromExport(
  identity: NonNullable<DatabaseExport["identity"]>
): MnemonicRecord {
  return {
    id: "mnemonic" as const,
    salt: new Uint8Array(identity.mnemonic.salt),
    iv: new Uint8Array(identity.mnemonic.iv),
    encrypted: new Uint8Array(identity.mnemonic.encrypted).buffer,
    // Absent = written before per-record counts existed = legacy 100k,
    // which is exactly what unlockIdentity assumes when it is undefined.
    ...(typeof identity.mnemonic.iterations === "number"
      ? { iterations: identity.mnemonic.iterations }
      : {}),
  };
}

export async function importDatabase(
  data: DatabaseExport,
  mode: "add" | "replace" = "replace",
  options: ImportOptions = {}
): Promise<ImportResult> {
  console.log(`[Sync] Importing database in ${mode} mode`);

  // "add" merges into the identity this device ALREADY has; an identity
  // section would overwrite it, which is a takeover, not a merge. Dropped
  // here rather than at each call site so every caller is covered - the file
  // restore stripped it, the device-sync target did not.
  const identity = mode === "add" ? undefined : data.identity;
  if (mode === "add" && data.identity) {
    console.warn(
      "[Sync] Ignoring the identity section: add mode keeps this device's identity"
    );
  }

  // Every collection below arrived via JSON (a backup file or a
  // device-sync frame) and is untrusted input: drop any record whose shape
  // doesn't match what storage/the UI expect rather than writing it through
  // unchecked. This is a cheap shape/size check, not signature verification
  // - see sanitizeCollections in backup.ts for why.
  const {
    messages,
    attachments,
    pending,
    watermarks,
    yjsDocs,
    rooms,
    profiles,
    savedGifs,
    dropped: droppedRecords,
  } = sanitizeCollections({
    messages: data.messages,
    attachments: data.attachments,
    pending: data.pending,
    watermarks: data.watermarks,
    yjsDocs: data.yjsDocs,
    rooms: data.rooms,
    profiles: data.profiles,
    savedGifs: data.savedGifs,
  });
  if (droppedRecords > 0) {
    console.warn(
      `[Sync] Dropped ${droppedRecords} malformed record(s) during import`
    );
  }
  const sanitizedData: DatabaseExport = {
    ...data,
    identity,
    messages,
    attachments,
    pending,
    watermarks,
    yjsDocs,
    rooms,
    profiles,
    savedGifs,
  };

  // Arm the at-rest key from the INCOMING identity before anything is wiped
  // or written. Without it the whole import lands in plaintext (no key exists
  // on a device that has never unlocked), and IndexedDB does not erase what a
  // later write overwrites - so the sweep that seals these rows leaves the
  // plaintext originals recoverable, which is exactly what the at-rest design
  // and the duress wipe assume never happens.
  let armed = false;
  if (identity && options.requestPassword) {
    const record = mnemonicRecordFromExport(identity);
    for (let retry = false; ; retry = true) {
      const password = await options.requestPassword(retry);
      // Cancelled: nothing has been wiped or written yet, and nothing will be.
      if (password == null) {
        throw new Error("Import cancelled - nothing on this device changed");
      }
      try {
        await unlockWithImportedMnemonic(record, password);
        armed = true;
        break;
      } catch (err) {
        // Only a mistyped password is worth asking again for; anything else
        // (a corrupt record, a broken WebCrypto) is not the user's to fix.
        if (!(err instanceof Error) || err.message !== "Wrong password") {
          throw err;
        }
      }
    }
  }

  if (mode === "replace") {
    // Clear existing data first
    console.log("[Sync] Wiping local database (replace mode)");
    await wipeLocalDatabase();
    // Replace mode installs a possibly DIFFERENT identity. Sealing the
    // imported rows with the currently armed key would brick them for the
    // identity that owns them, so drop the key: the rows land plaintext and
    // the first unlock as the RIGHT identity derives the right key and
    // sweeps them sealed. (DataSettings reloads after a replace restore, so
    // the stale session never touches storage again.) The armed case above is
    // the exception: that key IS the imported identity's.
    if (!armed) clearStorageCrypto();
  }
  // Fallback for an import with no identity to unlock with - a merge onto a
  // locked device, or a caller that asks for no password. A fresh sync target
  // has never unlocked, so no at-rest key exists yet: inside this window
  // sealRow passes rows through as plaintext instead of throwing, and the
  // sweep flag makes the first unlock seal all of it.
  const endPlaintextImport = armed ? null : beginPlaintextImport();
  // Unconditionally. The sweep flag is what stands between an import's
  // plaintext rows and permanence, so arming it must not depend on a
  // condition that happens to be true today.
  markAtRestSweepNeeded();
  try {
    await importDatabaseInner(sanitizedData, mode, options.onProgress);
  } finally {
    endPlaintextImport?.();
  }
  return { droppedRecords };
}

async function importDatabaseInner(
  data: DatabaseExport,
  mode: "add" | "replace",
  onProgress?: (done: number, total: number) => void
): Promise<void> {
  const total =
    data.messages.length +
    data.attachments.length +
    data.rooms.length +
    data.profiles.length +
    data.savedGifs.length +
    data.pending.length +
    data.watermarks.length +
    data.yjsDocs.length;
  let done = 0;
  const tick = (n = 1): void => {
    done += n;
    onProgress?.(done, total);
  };

  // Import identity only if provided, and never in "add" mode: a merge keeps
  // the identity this device already has. Re-checked here rather than trusted
  // from importDatabase so no future caller can reach this write in add mode.
  if (data.identity && mode !== "add") {
    console.log("[Sync] Importing identity");
    const mnemonicRecord = mnemonicRecordFromExport(data.identity);

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
  tick(data.messages.length);
  const writes: Promise<unknown>[] = [
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
  ];
  await Promise.all(writes.map((w) => w.then(() => tick())));
}

// ── File backup (QR-less alternative to device sync) ─────────────────────────

/**
 * Parse a backup file chosen by the user, WITHOUT decrypting it: an
 * encrypted file comes back as its envelope, and the caller asks for the
 * passphrase before calling decryptBackup.
 *
 * @throws if the file is not a backup this build understands.
 */
export async function readBackupFile(file: File): Promise<ParsedBackupFile> {
  return parseBackupFileText(await file.text());
}

/**
 * Apply a parsed backup.
 * "add" merges into the current identity; "replace" wipes local data first and
 * adopts the identity stored in the file (you then unlock with the password
 * that was in use when the backup was taken).
 */
export async function applyBackup(
  data: BackupFile,
  mode: "add" | "replace",
  options: ImportOptions = {}
): Promise<ImportResult> {
  if (mode === "replace" && !data.identity) {
    throw new Error("This backup has no identity, so it cannot replace yours");
  }
  // importDatabase drops the identity in add mode itself.
  return importDatabase(data, mode, options);
}

/**
 * Start camera scanning for QR codes.
 */
