import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getRoom, putMessage, putRoom, wipeLocalDatabase, type Room } from "$lib/storage";
import { clearStorageCrypto, initStorageCrypto } from "$lib/storage-crypto";
import { getRoomNotifyMode, setRoomNotifyMode } from "$lib/notify-prefs.svelte";
import { deriveRoomKeys, newRoomSecret } from "./keys";
import {
  adoptLegacyPredecessor,
  isLegacyRoomCode,
  legacyMoveInviteText,
  linkLegacyMove,
} from "./legacy-move";

const OLD = "6BMB3GST2JRJZ";
const ALICE = "did:key:z6MkAlice";
const BOB = "did:key:z6MkBob";

function room(roomCode: string, extra: Partial<Room> = {}): Room {
  return {
    roomCode,
    type: "room" as Room["type"],
    name: "Book club",
    lastSeenLamport: 0,
    createdAt: 1,
    participants: [],
    ...extra,
  };
}

/** A stored secure room: putRoom insists on the capability behind the ID. */
async function secureRoom(extra: Partial<Room> = {}): Promise<string> {
  const roomSecret = newRoomSecret();
  const roomCode = deriveRoomKeys(roomSecret).discoveryId;
  await putRoom(room(roomCode, { roomSecret, ...extra }));
  return roomCode;
}

beforeEach(async () => {
  await initStorageCrypto(new Uint8Array(32).fill(7));
  await wipeLocalDatabase();
});
afterEach(() => clearStorageCrypto());

describe("linkLegacyMove", () => {
  it("links both ways and carries the local settings over", async () => {
    await putRoom(room(OLD, { participants: [ALICE, BOB], pinnedAt: 5, position: 2, pfpURL: "https://x/p.png" }));
    const newCode = await secureRoom();
    setRoomNotifyMode(OLD, "mentions");

    await linkLegacyMove(OLD, newCode);

    const [oldRoom, newRoom] = [await getRoom(OLD), await getRoom(newCode)];
    expect(oldRoom?.movedTo).toBe(newCode);
    expect(newRoom).toMatchObject({ archiveOf: OLD, pinnedAt: 5, position: 2, pfpURL: "https://x/p.png" });
    expect(getRoomNotifyMode(newCode)).toBe("mentions");
  });

  it("refuses to move a room that is not an old one", async () => {
    const a = await secureRoom();
    const b = await secureRoom();
    await expect(linkLegacyMove(a, b)).rejects.toThrow("Only an old room");
  });
});

describe("adoptLegacyPredecessor", () => {
  let newCode: string;
  beforeEach(async () => {
    await putRoom(room(OLD, { participants: [ALICE, BOB] }));
    newCode = await secureRoom();
  });

  it("links our own copy of the old room when an old member announces it", async () => {
    expect(await adoptLegacyPredecessor(newCode, OLD, ALICE)).toBe(true);
    expect((await getRoom(newCode))?.archiveOf).toBe(OLD);
    expect((await getRoom(OLD))?.movedTo).toBe(newCode);
  });

  it("ignores an announcer who was never in the old room", async () => {
    expect(await adoptLegacyPredecessor(newCode, OLD, "did:key:z6MkMallory")).toBe(false);
    expect(await adoptLegacyPredecessor(newCode, OLD, undefined)).toBe(false);
    expect((await getRoom(newCode))?.archiveOf).toBeUndefined();
  });

  it("takes having written in the old room as membership, once the roster dropped them", async () => {
    const CAROL = "did:key:z6MkCarol";
    expect(await adoptLegacyPredecessor(newCode, OLD, CAROL)).toBe(false);
    await putMessage({ id: "m1", roomCode: OLD, senderId: CAROL, senderName: "Carol", lamport: 1, timestamp: 1, type: "text", content: "hi", attachments: [] } as never);
    expect(await adoptLegacyPredecessor(newCode, OLD, CAROL)).toBe(true);
    expect((await getRoom(newCode))?.archiveOf).toBe(OLD);
  });

  it("ignores an old room we do not hold, and keeps the first link", async () => {
    expect(await adoptLegacyPredecessor(newCode, "7QK3M9AB2CXYZ", ALICE)).toBe(false);
    expect(await adoptLegacyPredecessor(newCode, OLD, ALICE)).toBe(true);
    const other = await secureRoom();
    // Already moved: a second secure room cannot claim it too.
    expect(await adoptLegacyPredecessor(other, OLD, BOB)).toBe(false);
  });

  it("only takes a secure room as the new one, and a legacy-shaped code as the old", async () => {
    expect(await adoptLegacyPredecessor(OLD, OLD, ALICE)).toBe(false);
    expect(await adoptLegacyPredecessor(newCode, newCode, ALICE)).toBe(false);
  });
});

describe("helpers", () => {
  it("recognises legacy room codes and nothing secure", () => {
    for (const code of ["6BMB3GST2JRJZ", "a1b2c3", "0123456789abcdef"]) expect(isLegacyRoomCode(code)).toBe(true);
    for (const code of ["", "rd2_abc", "r2_abc", "dm-abc", "has space", 42]) expect(isLegacyRoomCode(code)).toBe(false);
  });

  it("writes an invite DM that apologises, names the old room and carries the link", () => {
    const text = legacyMoveInviteText("Book club", "https://awful.chat/r/#r2_x");
    expect(text).toContain("Sorry");
    expect(text).toContain('"Book club"');
    expect(text).toContain("https://awful.chat/r/#r2_x");
  });
});
