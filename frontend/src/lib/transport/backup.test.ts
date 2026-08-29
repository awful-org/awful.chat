import { describe, expect, it } from "vitest";
import {
  mergeImportedRoom,
  BACKUP_FORMAT,
  BACKUP_VERSION,
  isValidMessageRecord,
  MAX_MESSAGE_CONTENT_LENGTH,
  parseBackup,
  pfpFromJson,
  pfpToJson,
  sanitizeCollections,
  summarizeBackup,
  type BackupFile,
  bytesFromExport,
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
    expect(data.exportedAt).toBe(0);
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
  };

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
    expect(merged.createdAt).toBe(100);
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

  it("takes the imported watermark and name when they are the better ones", () => {
    const merged = mergeImportedRoom(
      { ...local, name: "abc", lastSeenLamport: 5 },
      { ...local, name: "Real Name", lastSeenLamport: 900 }
    );
    expect(merged.lastSeenLamport).toBe(900);
    expect(merged.name).toBe("Real Name");
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
