import { describe, expect, it } from "vitest";
import type { Room } from "../storage";
import {
  mergeImportedRoom,
  BACKUP_ENC_FORMAT,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  backupVersionFor,
  decryptBackup,
  encryptBackup,
  parseBackupFileText,
  isValidMessageRecord,
  MAX_MESSAGE_CONTENT_LENGTH,
  parseBackup,
  pfpFromJson,
  pfpToJson,
  sanitizeCollections,
  summarizeBackup,
  type BackupFile,
  bytesFromExport,
  roomProfileToExport,
  mergeImportedBlock,
  mergeImportedContact,
  sanitizeLocalState,
} from "./backup";

function backupJson(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: 1_700_000_000_000,
    messages: [],
    attachments: [],
    pending: [],
    watermarks: [],
    yjsDocs: [],
    rooms: [],
    profiles: [],
    savedGifs: [],
    ...overrides,
  });
}

describe("parseBackup", () => {
  it("accepts a well-formed backup", () => {
    const data = parseBackup(backupJson({ messages: [{ id: "m1" }] }));
    expect(data.format).toBe(BACKUP_FORMAT);
    expect(data.messages).toHaveLength(1);
  });

  it("rejects text that is not JSON", () => {
    expect(() => parseBackup("not json at all")).toThrow(/valid JSON/);
  });

  it("rejects JSON that is not a backup", () => {
    expect(() => parseBackup(JSON.stringify({ hello: "world" }))).toThrow(
      /not an awful\.chat backup/
    );
    expect(() => parseBackup("null")).toThrow(/not an awful\.chat backup/);
    expect(() => parseBackup('"a string"')).toThrow(
      /not an awful\.chat backup/
    );
  });

  it("refuses a backup from a newer app version", () => {
    expect(() => parseBackup(backupJson({ version: BACKUP_VERSION + 1 }))).toThrow(
      /newer version/
    );
    expect(() => parseBackup(backupJson({ version: "1" }))).toThrow(
      /newer version/
    );
  });

  // A truncated or hand-edited file must not blow up the import half way
  // through, so every collection is coerced to an array.
  it("coerces missing or malformed collections to empty arrays", () => {
    const data = parseBackup(
      JSON.stringify({
        format: BACKUP_FORMAT,
        version: BACKUP_VERSION,
        messages: "nope",
      })
    );
    expect(data.messages).toEqual([]);
    expect(data.rooms).toEqual([]);
    expect(data.attachments).toEqual([]);
    expect(data.savedGifs).toEqual([]);
    expect(data.roomProfiles).toEqual([]);
    expect(data.roomDeletions).toEqual([]);
    expect(data.exportedAt).toBe(0);
  });
});

describe("room profile backup records", () => {
  const base = {
    messages: [], attachments: [], pending: [], watermarks: [], yjsDocs: [],
    rooms: [], profiles: [], savedGifs: [],
  };

  it("retains explicit clears and edit clocks, and drops invalid fields or markers", () => {
    const record = { roomCode: "rd2_a", did: "did:alice", generation: 100,
      fields: { nickname: null, color: "#123456" },
      fieldEdits: { nickname: { at: 101, id: "device-a" } } };
    const result = sanitizeCollections({ ...base,
      roomProfiles: [record, { ...record, fields: { inboxOff: true } },
        { ...record, fields: { did: "spoofed identity" } },
        { ...record, fieldEdits: { nickname: { at: -1, id: "bad" } } }],
      roomDeletions: [{ roomCode: "rd2_b", generation: 120, deletedAt: 121 },
        { roomCode: "rd2_b", generation: -1, deletedAt: 121 }],
    });
    expect(result.roomProfiles).toEqual([record]);
    expect(result.roomDeletions).toEqual([{ roomCode: "rd2_b", generation: 120, deletedAt: 121 }]);
    expect(result.dropped).toBe(4);
  });

  // A v4 reader restores a file with no channels correctly, so only one that
  // holds channel data is marked as something it must refuse.
  it("marks a file v5 only when it holds channel data", () => {
    const room = { roomCode: "rd2_a", type: "text", name: "A", lastSeenLamport: 0, createdAt: 1, participants: [] };
    const msg = { id: "m1", roomCode: "rd2_a", senderId: "did:key:z", senderName: "Z", timestamp: 1, lamport: 1, type: "text", content: "x", attachments: [] };
    const version = (data: { messages: unknown[]; rooms: unknown[] }) => backupVersionFor(data as never);
    expect(version({ messages: [msg], rooms: [room] })).toBe(4);
    expect(version({ messages: [{ ...msg, channel: "abcdefgh" }], rooms: [room] })).toBe(5);
    expect(version({ messages: [msg], rooms: [{ ...room, channels: [{ id: "abcdefgh", kind: "text", name: "dev", position: 0, updatedAt: 1 }] }] })).toBe(5);
    expect(version({ messages: [msg], rooms: [{ ...room, channelSeen: { abcdefgh: 3 } }] })).toBe(5);
    expect(version({ messages: [msg], rooms: [{ ...room, channels: [], channelSeen: {}, channelPins: {} }] })).toBe(4);
    // And this build still reads a v5 file.
    expect(parseBackup(backupJson({ version: 5 })).version).toBe(5);
  });

  it("loads old backups without room collections", () => {
    expect(BACKUP_VERSION).toBe(5);
    const old = parseBackup(backupJson({ version: 2 }));
    expect(old.roomProfiles).toEqual([]);
    expect(old.roomDeletions).toEqual([]);
  });

  // A v3 file never carried the phonebook, blocks or local state. Coercing
  // them to [] would read as "the other device has none", which a merge
  // would then act on; absent says "not carried".
  it("leaves the phonebook, blocks and local state absent when an older file has none", () => {
    const old = parseBackup(backupJson({ version: 3 }));
    expect(old).not.toHaveProperty("phonebook");
    expect(old).not.toHaveProperty("blocks");
    expect(old).not.toHaveProperty("localState");
    const current = parseBackup(backupJson({
      version: 4, phonebook: [], blocks: [], localState: { dmCallsJoined: [] },
    }));
    expect(current.phonebook).toEqual([]);
    expect(current.blocks).toEqual([]);
    expect(current.localState).toEqual({ dmCallsJoined: [] });
  });

  it("encodes nested avatar and banner bytes while preserving reset clocks", () => {
    const record = roomProfileToExport({ roomCode: "rd2_a", did: "did:alice", generation: 100,
      fields: { pfpData: new Uint8Array([1, 2]).buffer, bannerData: new Uint8Array([3]).buffer,
        nickname: null },
      fieldEdits: { nickname: { at: 101, id: "device", reset: true } },
    });
    expect(record.fields.pfpData).toBe(btoa(String.fromCharCode(1, 2)));
    expect(record.fields.bannerData).toBe(btoa(String.fromCharCode(3)));
    expect(record.fields.nickname).toBeNull();
    expect(record.fieldEdits?.nickname).toEqual({ at: 101, id: "device", reset: true });
    expect(sanitizeCollections({ messages: [], attachments: [], pending: [], watermarks: [],
      yjsDocs: [], rooms: [], profiles: [], savedGifs: [], roomProfiles: [record] }).roomProfiles).toEqual([record]);
  });
});

describe("summarizeBackup", () => {
  it("reports identity presence and counts", () => {
    const withIdentity = parseBackup(
      backupJson({
        identity: {
          mnemonic: { salt: [], iv: [], encrypted: [] },
          keypair: { did: "did:key:zAbc", publicKey: [] },
        },
        messages: [{ id: "a" }, { id: "b" }],
        rooms: [{ roomCode: "r1" }],
      })
    ) as BackupFile;
    const s = summarizeBackup(withIdentity);
    expect(s.hasIdentity).toBe(true);
    expect(s.did).toBe("did:key:zAbc");
    expect(s.messages).toBe(2);
    expect(s.rooms).toBe(1);

    const without = summarizeBackup(parseBackup(backupJson()));
    expect(without.hasIdentity).toBe(false);
    expect(without.did).toBeNull();
  });
});

describe("avatar binary round-trip", () => {
  it("survives JSON, which a raw ArrayBuffer would not", () => {
    const bytes = new Uint8Array([1, 2, 3, 250]);
    const room = { roomCode: "r1", pfpData: bytes.buffer };

    // Raw JSON drops an ArrayBuffer to {} - this is the bug being guarded.
    expect(JSON.parse(JSON.stringify(room)).pfpData).toEqual({});

    const encoded = pfpToJson(room);
    const decoded = pfpFromJson(JSON.parse(JSON.stringify(encoded)));
    expect(new Uint8Array(decoded.pfpData as ArrayBuffer)).toEqual(bytes);
  });

  it("leaves records without an avatar untouched", () => {
    const room: { roomCode: string; pfpData?: unknown } = { roomCode: "r1" };
    expect(pfpToJson(room)).toEqual(room);
    expect(pfpFromJson(room)).toEqual(room);
  });

  it("drops a lossily-serialized avatar instead of storing garbage", () => {
    const fromOldPeer = { roomCode: "r1", pfpData: {} };
    expect(pfpFromJson(fromOldPeer)).toEqual({ roomCode: "r1" });
  });
});

describe("mergeImportedRoom", () => {
  const local = {
    roomCode: "abc",
    type: "text" as const,
    name: "Local Name",
    lastSeenLamport: 500,
    createdAt: 100,
    participants: ["did:key:zA"],
    participantLastSeen: { "did:key:zA": 50 },
  } as Room;

  it("never lowers the seen watermark or activity, unions members", () => {
    const merged = mergeImportedRoom(local, {
      ...local,
      name: "Imported",
      lastSeenLamport: 10,
      createdAt: 200,
      participants: ["did:key:zB"],
      participantLastSeen: { "did:key:zA": 5, "did:key:zB": 80 },
    });
    expect(merged.lastSeenLamport).toBe(500);
    expect(merged.createdAt).toBe(200);
    expect([...merged.participants].sort()).toEqual([
      "did:key:zA",
      "did:key:zB",
    ]);
    expect(merged.participantLastSeen).toEqual({
      "did:key:zA": 50,
      "did:key:zB": 80,
    });
    expect(merged.name).toBe("Local Name");
  });

  it("keeps this device's post-quantum DM state over an imported one, and adopts one it lacks", () => {
    const mine = { v: 1, ct: "mine", ek: "key" }, theirs = { v: 1, ct: "theirs", ek: "key" };
    const dm = { ...local, roomCode: "dm-x", type: "dm" as const, participantDid: "did:key:zA" };
    expect((mergeImportedRoom({ ...dm, pq: mine } as never, { ...dm, pq: theirs }) as { pq: unknown }).pq).toEqual(mine);
    expect((mergeImportedRoom({ ...dm, pq: mine } as never, dm) as { pq?: unknown }).pq).toEqual(mine);
    expect((mergeImportedRoom(dm as never, { ...dm, pq: theirs }) as { pq: unknown }).pq).toEqual(theirs);
    expect(mergeImportedRoom(local, local)).not.toHaveProperty("pq");
  });

  it("takes the imported watermark and name when they are the better ones", () => {
    const merged = mergeImportedRoom(
      { ...local, name: "abc", lastSeenLamport: 5 },
      { ...local, name: "Real Name", lastSeenLamport: 900 }
    );
    expect(merged.lastSeenLamport).toBe(900);
    expect(merged.name).toBe("Real Name");
  });

  it("keeps this device's pin and position, filling in only what it lacks", () => {
    const kept = mergeImportedRoom(
      { ...local, pinnedAt: 1, position: 2 },
      { ...local, pinnedAt: 99, position: 7 }
    );
    expect(kept.pinnedAt).toBe(1);
    expect(kept.position).toBe(2);

    const filled = mergeImportedRoom(local, { ...local, pinnedAt: 99, position: 7 });
    expect(filled.pinnedAt).toBe(99);
    expect(filled.position).toBe(7);
  });

  it("unions pinned messages from both devices", () => {
    const merged = mergeImportedRoom(
      { ...local, pinnedMessages: ["m1", "m2"] },
      { ...local, pinnedMessages: ["m2", "m3"] }
    );
    expect(merged.pinnedMessages).toEqual(["m1", "m2", "m3"]);
  });

  // The name stayed local while nameAt came from the import, so an older
  // name could carry a newer stamp - and win the next announcement against a
  // real rename, putting the old name back for the whole room.
  it("takes the name and its stamp together, from whichever is newer", () => {
    const renamedHere = { ...local, name: "Renamed", nameAt: 2_000 };
    const kept = mergeImportedRoom(renamedHere, { ...local, name: "Old", nameAt: 1_000 });
    expect(kept.name).toBe("Renamed");
    expect(kept.nameAt).toBe(2_000);

    const renamedThere = mergeImportedRoom(renamedHere, { ...local, name: "Newer", nameAt: 3_000 });
    expect(renamedThere.name).toBe("Newer");
    expect(renamedThere.nameAt).toBe(3_000);

    // A stampless local name is older than any stamped rename.
    const legacy = mergeImportedRoom(local, { ...local, name: "Stamped", nameAt: 5 });
    expect(legacy.name).toBe("Stamped");
    expect(legacy.nameAt).toBe(5);
    // And a stamped local name does not pick up a stamp it never had.
    const stampless = mergeImportedRoom(renamedHere, { ...local, name: "Stampless" });
    expect(stampless.name).toBe("Renamed");
    expect(stampless.nameAt).toBe(2_000);
    const noStamp = mergeImportedRoom(local, { ...local, nameAt: 0, name: "Room" });
    expect(noStamp).not.toHaveProperty("nameAt");
  });

  it("never turns an accepted DM back into a request", () => {
    const dm = { ...local, roomCode: "dm-x", type: "dm" as const, participantDid: "did:key:zA" };
    const req = (request: boolean | undefined) => (request === undefined ? dm : { ...dm, request });
    const merge = (here: boolean | undefined, there: boolean | undefined) =>
      (mergeImportedRoom(req(here) as never, req(there)) as { request?: boolean }).request;
    // Accepted here - explicitly, or from before requests existed.
    expect(merge(false, true)).toBe(false);
    expect(merge(undefined, true)).toBe(false);
    // Accepted on the other device: that was the user's answer.
    expect(merge(true, false)).toBe(false);
    expect(merge(true, undefined)).toBe(false);
    // A request on both stays one.
    expect(merge(true, true)).toBe(true);
    expect(merge(undefined, undefined)).toBeUndefined();
  });

  it("keeps the fields only this device has, and this device's room picture", () => {
    const here = {
      ...local, movedTo: "rd2_new", archiveOf: "legacy-room", seenAt: 900,
      pfpURL: "https://example.invalid/here.png",
    };
    const merged = mergeImportedRoom(here, {
      ...local, seenAt: 500, pfpData: new Uint8Array([1]).buffer,
    });
    expect(merged.movedTo).toBe("rd2_new");
    expect(merged.archiveOf).toBe("legacy-room");
    expect(merged.seenAt).toBe(900);
    // As a pair: the import's bytes beside this device's URL showed neither.
    expect(merged.pfpURL).toBe("https://example.invalid/here.png");
    expect(merged).not.toHaveProperty("pfpData");

    const filled = mergeImportedRoom(local, { ...local, seenAt: 500, movedTo: "rd2_there",
      pfpURL: "https://example.invalid/there.png" });
    expect(filled.seenAt).toBe(500);
    expect(filled.movedTo).toBe("rd2_there");
    expect(filled.pfpURL).toBe("https://example.invalid/there.png");
  });
});

describe("merging soft blocks", () => {
  const did = "did:key:zMallory";

  it("keeps a block active on either device, with both devices' lifted windows", () => {
    const merged = mergeImportedBlock(
      { did, name: "Mallory", blockedAt: 500, earlier: [[10, 20]] },
      { did, name: "M", blockedAt: 100, unblockedAt: 300, earlier: [[30, 40]] },
    );
    expect(merged.unblockedAt).toBeUndefined();
    expect(merged.blockedAt).toBe(500);
    expect(merged.name).toBe("Mallory");
    expect(merged.earlier).toEqual([[10, 20], [30, 40], [100, 300]]);

    const activeThere = mergeImportedBlock(
      { did, name: "Mallory", blockedAt: 100, unblockedAt: 300 },
      { did, name: "Mallory", blockedAt: 50 },
    );
    expect(activeThere.unblockedAt).toBeUndefined();
    expect(activeThere.blockedAt).toBe(50);
    expect(activeThere.earlier).toEqual([[100, 300]]);
  });

  it("keeps every window of a block lifted on both, the latest as its own", () => {
    const merged = mergeImportedBlock(
      { did, name: "Mallory", blockedAt: 100, unblockedAt: 300 },
      { did, name: "Mallory", blockedAt: 400, unblockedAt: 600, earlier: [[100, 300]] },
    );
    expect(merged).toEqual({ did, name: "Mallory", blockedAt: 400, unblockedAt: 600, earlier: [[100, 300]] });
  });

  it("takes an entry this device never had as it came", () => {
    const imported = { did, name: "Mallory", blockedAt: 100 };
    expect(mergeImportedBlock(undefined, imported)).toBe(imported);
  });
});

describe("merging phonebook rows", () => {
  it("unions them: earliest added, favorite on either, this device's nickname", () => {
    const merged = mergeImportedContact(
      { peerId: "12D3KooWBob", nickname: "Bob", addedAt: 500 },
      { peerId: "12D3KooWBob", did: "did:key:zBob", nickname: "Robert", addedAt: 100, favorite: true },
    );
    expect(merged).toEqual({ peerId: "12D3KooWBob", did: "did:key:zBob", nickname: "Bob",
      addedAt: 100, favorite: true });
    const unnamed = mergeImportedContact(
      { peerId: "did:key:zBob", nickname: "", addedAt: 5 },
      { peerId: "did:key:zBob", nickname: "Bob", addedAt: 9 },
    );
    expect(unnamed.nickname).toBe("Bob");
    expect(unnamed).not.toHaveProperty("favorite");
  });
});

describe("the new export sections are checked like the rest", () => {
  const base = {
    messages: [], attachments: [], pending: [], watermarks: [], yjsDocs: [],
    rooms: [], profiles: [], savedGifs: [],
  };

  it("drops malformed phonebook and block rows, and counts them", () => {
    const out = sanitizeCollections({
      ...base,
      phonebook: [
        { peerId: "12D3KooWBob", nickname: "Bob", addedAt: 1 },
        { peerId: "", nickname: "Nobody", addedAt: 1 },
        { peerId: "12D3KooWEve", nickname: "Eve", addedAt: 1, did: "not-a-did" },
      ],
      blocks: [
        { did: "did:key:zMallory", name: "Mallory", blockedAt: 1, earlier: [[1, 2]] },
        { did: "12D3KooWNotADid", name: "x", blockedAt: 1 },
        { did: "did:key:zTrent", name: "Trent", blockedAt: 1, earlier: [[1]] },
      ],
    });
    expect(out.phonebook?.map((e) => e.peerId)).toEqual(["12D3KooWBob"]);
    expect(out.blocks?.map((e) => e.did)).toEqual(["did:key:zMallory"]);
    expect(out.dropped).toBe(4);
  });

  it("leaves lists an export never carried undefined, not empty", () => {
    const out = sanitizeCollections(base);
    expect(out.phonebook).toBeUndefined();
    expect(out.blocks).toBeUndefined();
  });

  it("keeps only local-state fields of the right type", () => {
    expect(sanitizeLocalState({
      peerVolumes: { "did:key:zA": 0.5 }, voiceWithheld: "did:key:zA",
      dmCallsJoined: ["call-1"], dmQueue: 42, extra: true,
    })).toEqual({ peerVolumes: { "did:key:zA": 0.5 }, dmCallsJoined: ["call-1"] });
    expect(sanitizeLocalState(["not", "an", "object"])).toBeUndefined();
    expect(sanitizeLocalState(undefined)).toBeUndefined();
  });
});

function validMessage(overrides: Record<string, unknown> = {}) {
  return {
    id: "m1",
    roomCode: "r1",
    senderId: "did:key:zAlice",
    senderName: "Alice",
    timestamp: 1,
    lamport: 1,
    type: "text",
    content: "hello",
    attachments: [],
    ...overrides,
  };
}

describe("isValidMessageRecord", () => {
  it("accepts a well-formed message", () => {
    expect(isValidMessageRecord(validMessage())).toBe(true);
  });

  it("rejects records missing or mistyping required fields", () => {
    expect(isValidMessageRecord(null)).toBe(false);
    expect(isValidMessageRecord("not an object")).toBe(false);
    expect(isValidMessageRecord(validMessage({ id: 123 }))).toBe(false);
    expect(isValidMessageRecord(validMessage({ roomCode: undefined }))).toBe(
      false
    );
    expect(isValidMessageRecord(validMessage({ senderId: "" }))).toBe(false);
    expect(isValidMessageRecord(validMessage({ content: 42 }))).toBe(false);
  });

  it("rejects a message type outside the known enum", () => {
    expect(isValidMessageRecord(validMessage({ type: "not_a_type" }))).toBe(
      false
    );
  });

  it("rejects a non-finite or negative lamport", () => {
    expect(isValidMessageRecord(validMessage({ lamport: -1 }))).toBe(false);
    expect(isValidMessageRecord(validMessage({ lamport: NaN }))).toBe(false);
    expect(isValidMessageRecord(validMessage({ lamport: Infinity }))).toBe(
      false
    );
    expect(isValidMessageRecord(validMessage({ lamport: "1" }))).toBe(false);
  });

  it("accepts content right at the size cap and rejects content over it", () => {
    const atCap = "a".repeat(MAX_MESSAGE_CONTENT_LENGTH);
    expect(isValidMessageRecord(validMessage({ content: atCap }))).toBe(true);
    const overCap = "a".repeat(MAX_MESSAGE_CONTENT_LENGTH + 1);
    expect(isValidMessageRecord(validMessage({ content: overCap }))).toBe(
      false
    );
  });
});

describe("sanitizeCollections", () => {
  it("drops malformed records per collection and reports a total count", () => {
    const result = sanitizeCollections({
      messages: [validMessage(), { id: "bad" }, validMessage({ id: "m2" })],
      attachments: [{ not: "an attachment" }],
      pending: [],
      watermarks: [
        { roomCode: "r1", senderId: "did:key:zAlice", maxLamport: 5 },
        { roomCode: "r1" }, // missing senderId/maxLamport
      ],
      yjsDocs: [],
      rooms: [],
      profiles: [],
      savedGifs: [],
    });

    expect(result.messages).toHaveLength(2);
    expect(result.attachments).toHaveLength(0);
    expect(result.watermarks).toHaveLength(1);
    // 1 bad message + 1 bad attachment + 1 bad watermark
    expect(result.dropped).toBe(3);
  });

  it("keeps every record when the input is already well-formed", () => {
    const result = sanitizeCollections({
      messages: [validMessage()],
      attachments: [],
      pending: [],
      watermarks: [],
      yjsDocs: [],
      rooms: [],
      profiles: [],
      savedGifs: [],
    });
    expect(result.dropped).toBe(0);
    expect(result.messages).toHaveLength(1);
  });
});

describe("bytesFromExport", () => {
  it("decodes both the base64 and the legacy number[] encodings", () => {
    const bytes = [104, 105, 33];
    const fromLegacy = bytesFromExport(bytes);
    const fromB64 = bytesFromExport(btoa("hi!"));
    expect([...new Uint8Array(fromLegacy!)]).toEqual(bytes);
    expect([...new Uint8Array(fromB64!)]).toEqual(bytes);
  });

  it("returns undefined for absent or garbage data", () => {
    expect(bytesFromExport(undefined)).toBeUndefined();
    expect(bytesFromExport("%%%not-base64%%%")).toBeUndefined();
  });
});

// The export is the whole account in the clear once opened - every message,
// room code, DID and attachment - so the FILE is one AES-GCM blob under a
// passphrase chosen at export time. Files written before that (plaintext,
// version 1 and 2) still have to restore, which is why the encrypted form
// carries its own format marker rather than another version bump.
describe("encrypted backup files", () => {
  const PASSPHRASE = "a passphrase for the file itself";

  const secretBackup = () =>
    parseBackup(
      backupJson({
        rooms: [{ roomCode: "cafebabe0000ffff", type: "text" }],
        messages: [
          {
            id: "m1",
            roomCode: "cafebabe0000ffff",
            senderId: "did:key:zAlice",
            type: "text",
            lamport: 1,
            content: "the quiet part",
          },
        ],
      })
    );

  it("round-trips and leaves nothing readable in the file", async () => {
    const envelope = await encryptBackup(secretBackup(), PASSPHRASE);
    const onDisk = JSON.stringify(envelope);
    expect(onDisk).not.toContain("cafebabe0000ffff");
    expect(onDisk).not.toContain("the quiet part");
    expect(onDisk).not.toContain("did:key:zAlice");

    const parsed = parseBackupFileText(onDisk);
    expect(parsed.encrypted).toBe(true);
    if (parsed.encrypted !== true) throw new Error("expected an envelope");
    const restored = await decryptBackup(parsed.envelope, PASSPHRASE);
    expect(restored.rooms).toEqual(secretBackup().rooms);
    expect(restored.messages[0].content).toBe("the quiet part");
  });

  it("fails cleanly on the wrong passphrase", async () => {
    const envelope = await encryptBackup(secretBackup(), PASSPHRASE);
    await expect(decryptBackup(envelope, "not it")).rejects.toThrow(
      /passphrase/i
    );
  });

  it("refuses a tampered ciphertext rather than importing half of it", async () => {
    const envelope = await encryptBackup(secretBackup(), PASSPHRASE);
    const bytes = [...atob(envelope.ciphertext)].map((c) => c.charCodeAt(0));
    bytes[0] ^= 0xff;
    envelope.ciphertext = btoa(String.fromCharCode(...bytes));
    await expect(decryptBackup(envelope, PASSPHRASE)).rejects.toThrow();
  });

  it("still reads a plaintext file from before encryption existed", () => {
    const parsed = parseBackupFileText(
      backupJson({ version: 1, messages: [{ id: "m1" }] })
    );
    expect(parsed.encrypted).toBe(false);
    if (parsed.encrypted !== false) throw new Error("expected a plain backup");
    expect(parsed.backup.messages).toHaveLength(1);
  });

  it("rejects an envelope with a KDF cost that would hang the tab", () => {
    expect(() =>
      parseBackupFileText(
        JSON.stringify({
          format: BACKUP_ENC_FORMAT,
          version: 1,
          kdf: { salt: "AAAA", iterations: 1e12 },
          iv: "AAAA",
          ciphertext: "AAAA",
        })
      )
    ).toThrow(/damaged/i);
  });
});
