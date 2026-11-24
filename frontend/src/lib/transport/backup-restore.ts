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
  bulkAddNewMessages,
  putAttachment,
  getAttachment,
  putRoom,
  putPeerProfile,
  putOwnProfile,
  putSavedGif,
  getRoom,
  setWatermark,
  getOwnProfile,
  getPeerProfile,
  getOwnRoomProfile,
  getAllOwnRoomProfiles,
  putOwnRoomProfile,
  getAllRoomDeletionMarkers,
  deleteRoomProfilesForRoom,
  putRoomDeletionMarker,
  roomDeletionCutoff,
  getKeypairRecord,
  markAtRestSweepNeeded,
  getBlockEntries,
  putBlockEntry,
  getPhonebookEntries,
  putPhonebookEntry,
  dedupePhonebook,
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
  RoomDeletionMarker,
  OwnRoomProfileRecord,
  BlockEntry,
  PhonebookEntry,
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
  EXPORT_SECTIONS,
  type ParsedBackupFile,
  type RoomProfileExport,
  isValidRoomDeletionMarker,
  mergeImportedBlock,
  mergeImportedContact,
  sanitizeLocalState,
} from "./backup";
import { sanitizeRoomProfileFields, type RoomProfileField } from "../room-profile";
import { messageIdAllowedFor } from "../message-id";
import { allowsUnsignedDmHistory } from "./dm-ownership";
import type { WireChatMessage } from "../types/message";
import { reloadBlocks } from "../blocks.svelte";
import { forgetPlaces } from "../room-location";
import { importPeerAudioPrefs } from "./audio-prefs";
import { importDmCallsJoined } from "../dm-call-joined";
import { importDmQueueBlob } from "./dm-queue";

/**
 * How far ahead of our clock a leave marker may be dated. A marker refuses
 * every room generation at or below it, so one dated in the far future - in
 * a backup file, or from a paired device with a broken clock - would refuse
 * this room's profiles until then.
 */
export const MAX_MARKER_SKEW_MS = 5 * 60_000;

/**
 * Leave markers from another device or a backup. They govern ROOM PROFILES
 * only: the overrides of a room generation that was left elsewhere are
 * dropped, and never come back. They never remove a room or its history -
 * leaving a room on one device is not a decision about this one, and a merge
 * keeps what is already here (bulkAddNewMessages). A room this device still
 * holds in the generation the marker names is left entirely alone.
 */
export async function applyRoomDeletionMarkers(markers: unknown[]): Promise<void> {
  const latest = Date.now() + MAX_MARKER_SKEW_MS;
  const local = new Map((await getAllRoomDeletionMarkers()).map(m => [m.roomCode, m]));
  for (const value of markers) {
    if (!isValidRoomDeletionMarker(value)) continue;
    const marker = value as RoomDeletionMarker;
    if (marker.generation > latest || marker.deletedAt > latest) continue;
    const held = local.get(marker.roomCode);
    if (held && roomDeletionCutoff(held) >= roomDeletionCutoff(marker)) continue;
    const room = await getRoom(marker.roomCode);
    if (room?.type === "text") {
      if (room.createdAt <= roomDeletionCutoff(marker)) continue;
      // Rejoined here since: the overrides are the new generation's. Keep the
      // marker, so an older snapshot cannot bring the old ones back.
      await putRoomDeletionMarker(marker);
    } else {
      await deleteRoomProfilesForRoom(marker.roomCode, marker.generation, marker.deletedAt);
    }
    local.set(marker.roomCode, marker);
  }
}

function roomProfileFromExport(raw: RoomProfileExport): OwnRoomProfileRecord {
  const fields = { ...raw.fields } as OwnRoomProfileRecord["fields"];
  for (const key of ["pfpData", "bannerData"] as const) {
    const value = raw.fields[key];
    if (typeof value === "string") {
      const bytes = bytesFromExport(value);
      if (bytes) fields[key] = bytes;
      else delete fields[key];
    }
  }
  // A file someone handed you: every value is checked like one off the wire.
  return { ...raw, fields: sanitizeRoomProfileFields(fields) };
}

function mergeOwnRoomProfile(local: OwnRoomProfileRecord, remote: OwnRoomProfileRecord): OwnRoomProfileRecord {
  const fields = { ...local.fields };
  const fieldEdits = { ...local.fieldEdits };
  const keys = new Set([...Object.keys(local.fields), ...Object.keys(remote.fields),
    ...Object.keys(local.fieldEdits ?? {}), ...Object.keys(remote.fieldEdits ?? {})]) as Set<RoomProfileField>;
  for (const key of keys) {
    const before = local.fieldEdits?.[key] ?? { at: 0, id: "" };
    const after = remote.fieldEdits?.[key] ?? { at: 0, id: "" };
    if (after.at < before.at || (after.at === before.at && after.id < before.id)) continue;
    if (after.at === before.at && after.id === before.id &&
        Object.hasOwn(local.fields, key)) continue;
    if (remote.fieldEdits?.[key]) fieldEdits[key] = remote.fieldEdits[key];
    if (remote.fieldEdits?.[key]?.reset || !Object.hasOwn(remote.fields, key)) delete fields[key];
    else (fields as Record<string, unknown>)[key] = remote.fields[key];
  }
  return { ...local, fields, fieldEdits };
}
import { publicKeyToDid, unlockWithImportedMnemonic, validPbkdf2Iterations } from "../identity/identity";
import type { MnemonicRecord } from "../identity/identity";

export interface ImportResult {
  /** Records dropped by the per-record shape/size validator (see
   * sanitizeCollections in backup.ts) across every collection - a backup or
   * device-sync export is untrusted input, and this is what a caller can
   * show the user instead of silently importing a partial dataset. */
  droppedRecords: number;
}

export interface ImportOptions {
  /** Synchronous cancellation check immediately before irreversible identity
   * activation/database mutation. Throw to abort with no import writes. Once
   * accepted, callers must serialize replacement operations until settlement;
   * the multi-transaction import cannot be rolled back after this boundary. */
  beforeCommit?: () => void;
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
  /**
   * The account the data says it came from, when the sender named it - a
   * device sync's source does, after proving it holds that account's key. A
   * merge from any other account is refused before anything is written:
   * merging takes the other device's own profile and room overrides as
   * this account's, which is only true of the same account.
   */
  sourceDid?: string;
}

export const DIFFERENT_ACCOUNT_MERGE =
  "The other device is signed in to a different account. Merging only works between devices of the same account - nothing on this device was changed.";

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
    // Anything else must be a count this app could have written: a file
    // claiming billions made every unlock spin.
    ...(identity.mnemonic.iterations !== undefined
      ? { iterations: checkedIterations(identity.mnemonic.iterations) }
      : {}),
  };
}

function checkedIterations(value: unknown): number {
  if (!validPbkdf2Iterations(value)) throw new Error("Invalid backup: bad identity record");
  return value;
}

/** The keypair section must at least be one key's own DID. */
function checkedKeypair(identity: NonNullable<DatabaseExport["identity"]>): { did: string; publicKey: Uint8Array<ArrayBuffer> } {
  const publicKey = new Uint8Array(identity.keypair.publicKey) as Uint8Array<ArrayBuffer>;
  if (publicKey.length !== 32 || publicKeyToDid(publicKey) !== identity.keypair.did) {
    throw new Error("Invalid backup: the identity's key does not match its DID");
  }
  return { did: identity.keypair.did, publicKey };
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
  // The account a merge writes into. Read before anything else happens, so
  // a merge from another account stops here with nothing touched.
  const localDid = mode === "add" ? (await getKeypairRecord())?.did : undefined;
  if (mode === "add" && options.sourceDid !== undefined && options.sourceDid !== localDid) {
    throw new Error(DIFFERENT_ACCOUNT_MERGE);
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
    roomProfiles,
    roomDeletions,
    savedGifs,
    phonebook,
    blocks,
    dropped: droppedRecords,
  } = sanitizeCollections({
    messages: data.messages,
    attachments: data.attachments,
    pending: data.pending,
    watermarks: data.watermarks,
    yjsDocs: data.yjsDocs,
    rooms: data.rooms,
    profiles: data.profiles,
    roomProfiles: data.roomProfiles,
    roomDeletions: data.roomDeletions,
    savedGifs: data.savedGifs,
    phonebook: data.phonebook,
    blocks: data.blocks,
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
    roomProfiles,
    roomDeletions,
    savedGifs,
    phonebook,
    blocks,
    localState: sanitizeLocalState(data.localState),
  };

  // Arm the at-rest key from the INCOMING identity before anything is wiped
  // or written. Without it the whole import lands in plaintext (no key exists
  // on a device that has never unlocked), and IndexedDB does not erase what a
  // later write overwrites - so the sweep that seals these rows leaves the
  // plaintext originals recoverable, which is exactly what the at-rest design
  // and the duress wipe assume never happens.
  let armed = false;
  let committed = false;
  const beforeCommit = () => {
    if (committed) return;
    options.beforeCommit?.();
    committed = true;
  };
  if (identity && options.requestPassword) {
    const record = mnemonicRecordFromExport(identity);
    for (let retry = false; ; retry = true) {
      const password = await options.requestPassword(retry);
      // Cancelled: nothing has been wiped or written yet, and nothing will be.
      if (password == null) {
        throw new Error("Import cancelled - nothing on this device changed");
      }
      try {
        // Unlocking checks the phrase really is the DID the backup names.
        await unlockWithImportedMnemonic(record, password, beforeCommit, checkedKeypair(identity).did);
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

  beforeCommit();
  if (mode === "replace") {
    // Clear existing data first
    console.log("[Sync] Wiping local database (replace mode)");
    await wipeLocalDatabase();
    // What reads the DMs in the tabs' history goes with them. Not a parked
    // invitation: a restore may be what it was waiting for.
    forgetPlaces();
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
  // condition that happens to be true today. Scoped to the account the rows
  // are written into when that is known - a merge - because clearing every
  // account's flag made each of them re-sweep a database nobody had touched.
  // A replace may install a different identity, so it clears them all.
  markAtRestSweepNeeded(localDid);
  try {
    // A device sync whose source proved it is this account (checked above)
    // hands over our own history, as a replace would take it whole.
    const ownDevice = mode === "add" && options.sourceDid !== undefined && options.sourceDid === localDid;
    await importDatabaseInner(sanitizedData, mode, options.onProgress, ownDevice);
  } finally {
    endPlaintextImport?.();
  }
  // A merge lands in a running session, which read its block list at unlock
  // and acts on it synchronously everywhere. (A replace is followed by a
  // reload, which reads everything afresh.)
  if (mode === "add") await reloadBlocks().catch(() => {});
  return { droppedRecords };
}

/** Messages per import transaction; see the loop in importDatabaseInner. */
const IMPORT_CHUNK = 200;

/**
 * The rows of a merge that history sync from our own paired device would take
 * too (transport.svelte.ts _handleSyncBatch, verify-incoming.ts), and nothing
 * more: a merge carries the same kind of data on a different road.
 *
 * - A bound id must name its sender (message-id.ts), signed or not.
 * - A signed row must verify, under the DID it claims to be from.
 * - Unsigned is legitimate for one kind of row only: a mirrored DM text,
 *   reply or reaction with no files, whose authenticity came from the
 *   encrypted envelope it first arrived in (allowsUnsignedDmHistory, with
 *   "*" for our own device). Anything else unsigned - a room message in
 *   anybody's name - was refused on the way in everywhere else, and used to
 *   be kept here because it simply carried no signature to fail.
 */
async function mergeableMessages(messages: Message[], ownDevice = false): Promise<Message[]> {
  const { verifyMessage } = await import("../messaging");
  const keep = await Promise.all(messages.map(async (m) => {
    if (!messageIdAllowedFor(m.id, m.senderId)) return false;
    if (!m.sig) {
      // From our own other device - its source proved this account - the
      // rows are history that device already accepted (room messages from
      // before signing, mirrored DM files), and a replace would take them
      // whole. From a file or another account, only the one legitimately
      // unsigned kind.
      if (ownDevice) return true;
      return m.roomCode.startsWith("dm-") &&
        allowsUnsignedDmHistory(m as unknown as WireChatMessage, "*", false);
    }
    return m.senderDid === m.senderId && (await verifyMessage(m));
  }));
  return messages.filter((_, i) => keep[i]);
}

async function importDatabaseInner(
  data: DatabaseExport,
  mode: "add" | "replace",
  onProgress?: (done: number, total: number) => void,
  ownDevice = false
): Promise<void> {
  // Markers lead the import, so an override from a generation that was left
  // is never written back (applyRoomDeletionMarkers: profiles only).
  await applyRoomDeletionMarkers(data.roomDeletions ?? []);
  const markers = new Map((await getAllRoomDeletionMarkers()).map(m => [m.roomCode, roomDeletionCutoff(m)]));
  const survives = (roomCode: string, generation: number): boolean =>
    generation > (markers.get(roomCode) ?? -1);
  const total = EXPORT_SECTIONS.reduce((n, k) => n + (data[k]?.length ?? 0), 0);
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

    const keypairRecord = { id: "keypair" as const, ...checkedKeypair(data.identity) };

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
  // In chunks, each its own transaction, so progress moves while the
  // longest phase runs: one transaction for the whole history reported
  // nothing until every row was sealed and written, and on a phone with a
  // real history that silence outlasted the source's ack clock.
  for (let i = 0; i < data.messages.length; i += IMPORT_CHUNK) {
    const chunk = data.messages.slice(i, i + IMPORT_CHUNK);
    if (mode === "add") {
      // A merge keeps what is already here: see bulkAddNewMessages. And a
      // row that carries a signature which does not verify is a forgery -
      // every version a real row was ever signed with still verifies - while
      // an unsigned one is kept only where it is legitimately unsigned.
      await bulkAddNewMessages(await mergeableMessages(chunk, ownDevice));
    } else {
      await bulkPutMessages(chunk);
    }
    tick(chunk.length);
  }
  // The account these rows now belong to: the one just installed on a
  // replace, this device's own on a merge. Our own overrides and our own
  // profile are only ever this one's: a row under another DID would be shown
  // as ours.
  const selfDid = (await getKeypairRecord())?.did;
  // What this device holds already, for the lists a merge unions.
  const localBlocks = mode === "add" && data.blocks?.length
    ? new Map((await getBlockEntries()).map((e) => [e.did, e]))
    : new Map<string, BlockEntry>();
  const localContacts = mode === "add" && data.phonebook?.length
    ? new Map((await getPhonebookEntries()).map((e) => [e.peerId, e]))
    : new Map<string, PhonebookEntry>();
  const writes: Promise<unknown>[] = [
    ...data.attachments.map(async (a) => {
      // Likewise: a merge never replaces the bytes of a file already held.
      if (mode === "add" && (await getAttachment(a.id))) return;
      await putAttachment({
        ...a,
        data: bytesFromExport(a.data),
      } as Attachment);
    }),
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
      // The own profile is the one row under our own DID, and nothing else
      // is: getOwnProfile takes the first isMe row it finds, so one for
      // another DID would show as us, and a peer row under ours (another
      // device's cached copy of us) would overwrite who we are with it.
      if (importedProfile.isMe ? importedProfile.did !== selfDid : importedProfile.did === selfDid) {
        return Promise.resolve();
      }
      if (mode === "add") {
        return (async () => {
          if (importedProfile.isMe) {
            const localProfile = await getOwnProfile(selfDid);
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
              // A newer row from a device that never heard their PQ key must
              // not erase the one this device holds: losing it quietly drops
              // sealing for them back to X25519 only. Every use re-verifies
              // the certificate, so keeping either copy trusts nothing new.
              const pqKey =
                (importedProfile as PeerProfile).pqKey ?? localProfile?.pqKey;
              await putPeerProfile({
                ...(importedProfile as PeerProfile),
                ...(pqKey ? { pqKey } : {}),
              });
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
    ...(data.blocks ?? []).map((imported) =>
      putBlockEntry(mergeImportedBlock(localBlocks.get(imported.did), {
        ...imported,
        name: imported.name.slice(0, 64),
      }))
    ),
    ...(data.phonebook ?? []).map((imported) =>
      putPhonebookEntry(mergeImportedContact(localContacts.get(imported.peerId), imported))
    ),
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
  // The same contact keyed once by DID and once by peerId - the two devices
  // may have added them in different forms - is one contact.
  if (data.phonebook?.length) await dedupePhonebook();
  if (data.localState) await importLocalState(data.localState, mode);
  for (const local of await getAllOwnRoomProfiles()) {
    const room = await getRoom(local.roomCode);
    if (room?.type === "text" && room.createdAt !== local.generation &&
        survives(local.roomCode, local.generation)) {
      await putOwnRoomProfile({ ...local, generation: room.createdAt });
    }
  }
  for (const raw of data.roomProfiles ?? []) {
    if (selfDid && raw.did === selfDid && survives(raw.roomCode, raw.generation)) {
      const room = await getRoom(raw.roomCode);
      if (room?.type === "text") {
        // Separate devices can first join the same room at different times.
        // The marker check above prevents an older, pre-leave override from
        // being promoted into a deliberate rejoin.
        const imported = { ...roomProfileFromExport(raw), generation: room.createdAt };
        const local = mode === "add" ? await getOwnRoomProfile(raw.roomCode, raw.did) : undefined;
        await putOwnRoomProfile(local && local.generation === imported.generation
          ? mergeOwnRoomProfile(local, imported) : imported);
      }
    }
    tick();
  }
  tick((data.roomDeletions ?? []).length);
}

/**
 * The account state that lives in localStorage (LocalStateExport). Each part
 * only when the export carried it, so an older export leaves what is here
 * alone. The retry queue is last and may fail on its own: it needs the
 * session the import runs in, and a queue that does not merge must not undo
 * a merge that otherwise landed.
 */
async function importLocalState(
  state: NonNullable<DatabaseExport["localState"]>,
  mode: "add" | "replace"
): Promise<void> {
  if (state.peerVolumes !== undefined || state.voiceWithheld !== undefined) {
    importPeerAudioPrefs(state, mode);
  }
  if (state.dmCallsJoined !== undefined) importDmCallsJoined(state.dmCallsJoined, mode);
  try {
    await importDmQueueBlob(state.dmQueue, mode);
  } catch (err) {
    console.warn("[Sync] The DM retry queue did not merge:", err);
  }
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
