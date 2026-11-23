import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  closeDatabase,
  getAllMessages,
  getChannelUnreadCounts,
  getDB,
  getLastMessage,
  getMessages,
  getMessagesAboveWatermarks,
  getRoom,
  getUnreadCount,
  markRoomSeen,
  mergeRoomChannels,
  PAGE_SIZE,
  putMessage,
  putRoom,
  setMessagePinned,
  wipeLocalDatabase,
} from "./storage";
import { STORE_SPECS, clearStorageCrypto, initStorageCrypto, sealRow } from "./storage-crypto";
import { MessageType, type Message } from "./types/message";
import type { Channel } from "./channels";

// One room, its original chat and its channels, through the real storage
// module (fake-indexeddb, real at-rest crypto).

const KEY = new Uint8Array(32).fill(42);
const ROOM = "rd2_room";
const GAMES = "gamesgames";
const MUSIC = "musicmusic";
/** A room record of the legacy kind: a secure room's would need its capability. */
const PLAIN = "room-a";

let seq = 0;
function msg(over: Partial<Message> = {}): Message {
  seq += 1;
  return {
    id: `m-${String(seq).padStart(4, "0")}`,
    roomCode: ROOM,
    senderId: "alice",
    senderName: "Alice",
    timestamp: 1000 + seq,
    lamport: seq,
    type: MessageType.Text,
    content: `message ${seq}`,
    attachments: [],
    ...over,
  };
}

beforeEach(async () => {
  await initStorageCrypto(KEY);
  await wipeLocalDatabase();
  seq = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  clearStorageCrypto();
});

describe("a channel's rows on disk", () => {
  it("carry a blinded room+channel index field, and keep the channel itself sealed", async () => {
    await putMessage(msg({ channel: GAMES }));
    await putMessage(msg());
    const raw = (await (await getDB()).getAll("messages")) as unknown as Record<string, unknown>[];
    const tagged = raw.find((r) => r.id === "m-0001")!;
    const plain = raw.find((r) => r.id === "m-0002")!;
    expect(typeof tagged.roomChannel).toBe("string");
    expect(String(tagged.roomChannel).startsWith("b1:")).toBe(true);
    expect(JSON.stringify(tagged)).not.toContain(GAMES);
    expect("channel" in tagged).toBe(false);
    // The original chat's rows look exactly as they did before channels.
    expect("roomChannel" in plain).toBe(false);
  });

  it("index the pair, not the channel: the same id in another room is another page", async () => {
    await putMessage(msg({ channel: GAMES }));
    await putMessage(msg({ roomCode: "rd2_other", channel: GAMES }));
    expect((await getMessages(ROOM, undefined, undefined, GAMES)).map((m) => m.id)).toEqual(["m-0001"]);
    expect((await getMessages("rd2_other", undefined, undefined, GAMES)).map((m) => m.id)).toEqual(["m-0002"]);
  });

  it("give back the channel they were stored with", async () => {
    await putMessage(msg({ channel: GAMES }));
    const [m] = await getMessages(ROOM, undefined, undefined, GAMES);
    expect(m.channel).toBe(GAMES);
    expect("roomChannel" in m).toBe(false);
  });
});

describe("paging one channel", () => {
  it("pages each channel and the original chat apart, and the room whole", async () => {
    for (let i = 0; i < 70; i++) {
      await putMessage(msg(i % 3 === 0 ? {} : i % 3 === 1 ? { channel: GAMES } : { channel: MUSIC }));
    }
    const page = { capped: false };
    const games = await getMessages(ROOM, undefined, page, GAMES);
    expect(games.every((m) => m.channel === GAMES)).toBe(true);
    expect(games).toHaveLength(23);
    expect(page.capped).toBe(false);
    const original = await getMessages(ROOM, undefined, undefined, "");
    expect(original.every((m) => m.channel === undefined)).toBe(true);
    expect(original).toHaveLength(24);
    // Absent: the whole room, as every caller that needs it reads.
    const whole = { capped: false };
    expect(await getMessages(ROOM, undefined, whole)).toHaveLength(PAGE_SIZE);
    expect(whole.capped).toBe(true);
    expect(await getAllMessages(ROOM)).toHaveLength(70);
  });

  it("pages back through a channel by cursor, without the other channels' rows", async () => {
    for (let i = 0; i < 2 * PAGE_SIZE + 10; i++) {
      await putMessage(msg(i % 2 ? { channel: GAMES } : {}));
    }
    const first = { capped: false };
    const newest = await getMessages(ROOM, undefined, first, GAMES);
    expect(newest).toHaveLength(PAGE_SIZE);
    expect(first.capped).toBe(true);
    const older = await getMessages(ROOM, newest[0], undefined, GAMES);
    expect(older).toHaveLength(5);
    expect([...older, ...newest].every((m) => m.channel === GAMES)).toBe(true);
    const ids = new Set([...older, ...newest].map((m) => m.id));
    expect(ids.size).toBe(PAGE_SIZE + 5);
    // The original chat's page skips the channel rows on the same walk.
    const original = await getMessages(ROOM, undefined, undefined, "");
    expect(original.every((m) => m.channel === undefined)).toBe(true);
    expect(original).toHaveLength(PAGE_SIZE);
  });

  it("finds the newest row of a channel, and of the original chat", async () => {
    await putMessage(msg());
    await putMessage(msg({ channel: GAMES }));
    await putMessage(msg({ channel: MUSIC }));
    expect((await getLastMessage(ROOM))?.id).toBe("m-0003");
    expect((await getLastMessage(ROOM, ""))?.id).toBe("m-0001");
    expect((await getLastMessage(ROOM, GAMES))?.id).toBe("m-0002");
    expect(await getLastMessage(ROOM, "nothingnothing")).toBeUndefined();
  });

  it("leaves history sync whole-room: every channel's rows go to a peer that lacks them", async () => {
    await putMessage(msg());
    await putMessage(msg({ channel: GAMES }));
    const pushed = await getMessagesAboveWatermarks(ROOM, {});
    expect(pushed.map((m) => [m.id, m.channel])).toEqual([["m-0001", undefined], ["m-0002", GAMES]]);
  });
});

describe("unread per channel", () => {
  it("counts each channel against its own mark, and only the channels named", async () => {
    await putMessage(msg()); // 1
    await putMessage(msg({ channel: GAMES })); // 2
    await putMessage(msg({ channel: GAMES })); // 3
    await putMessage(msg({ channel: MUSIC })); // 4
    await putMessage(msg({ senderId: "me" })); // 5, ours
    await putMessage(msg({ channel: GAMES, type: MessageType.Reaction })); // 6
    await putMessage(msg()); // 7
    const counts = await getChannelUnreadCounts(ROOM, { base: 1, channels: { [GAMES]: 2 } }, "me");
    // MUSIC is not named (deleted, or not in the list yet): counted nowhere.
    expect(Object.fromEntries(counts)).toEqual({ "": 1, [GAMES]: 1 });
    // A room without channels counts what it always counted.
    expect(Object.fromEntries(await getChannelUnreadCounts(ROOM, { base: 0, channels: {} }, "me")))
      .toEqual({ "": 2 });
  });

  it("matches the whole-room count when nobody made a channel", async () => {
    for (let i = 0; i < 12; i++) await putMessage(msg({ senderId: i % 4 ? "bob" : "me" }));
    const before = await getUnreadCount(ROOM, 3, "me");
    const counts = await getChannelUnreadCounts(ROOM, { base: 3, channels: {} }, "me");
    expect(counts.get("")).toBe(before);
  });

  it("keeps a read mark per channel; the original chat's is lastSeenLamport", async () => {
    await putRoom({ roomCode: PLAIN, type: "text", name: "R", createdAt: 1, lastSeenLamport: 0, participants: [] });
    await markRoomSeen(PLAIN, 5, undefined, GAMES);
    await markRoomSeen(PLAIN, 3, undefined, GAMES); // never backwards
    await markRoomSeen(PLAIN, 2);
    const room = await getRoom(PLAIN);
    expect(room?.channelSeen).toEqual({ [GAMES]: 5 });
    expect(room?.lastSeenLamport).toBe(2);
  });
});

describe("the room's channel list and pins", () => {
  const STAMP = Date.now() - 10;
  const entry = (id: string, over: Partial<Channel> = {}): Channel => ({
    id, kind: "text", name: id, position: 1, updatedAt: STAMP, ...over,
  });

  it("merges an announced list into the stored room, entry by entry", async () => {
    await putRoom({ roomCode: PLAIN, type: "text", name: "R", createdAt: 1, lastSeenLamport: 0, participants: [] });
    const first = await mergeRoomChannels(PLAIN, [entry(GAMES)]);
    expect(first).toMatchObject({ changed: true, behind: false });
    const again = await mergeRoomChannels(PLAIN, [entry(GAMES)]);
    expect(again).toMatchObject({ changed: false, behind: false });
    const empty = await mergeRoomChannels(PLAIN, []);
    expect(empty).toMatchObject({ changed: false, behind: true });
    expect((await getRoom(PLAIN))?.channels?.map((c) => c.id)).toEqual([GAMES]);
    expect(await mergeRoomChannels("rd2_nope", [entry(GAMES)])).toBeNull();
  });

  it("keeps pins per channel, the original chat's where they always were", async () => {
    await putRoom({ roomCode: PLAIN, type: "text", name: "R", createdAt: 1, lastSeenLamport: 0, participants: [] });
    await setMessagePinned(PLAIN, "a", true);
    await setMessagePinned(PLAIN, "b", true, GAMES);
    const room = await getRoom(PLAIN);
    expect(room?.pinnedMessages).toEqual(["a"]);
    expect(room?.channelPins).toEqual({ [GAMES]: ["b"] });
  });
});

describe("upgrading a database from before channels", () => {
  it("adds the index without rewriting a row, and the old rows are the original chat", async () => {
    closeDatabase();
    await wipeLocalDatabase();
    // Version 10's messages store, holding rows sealed as version 10 sealed
    // them - which is how this build seals a row with no channel.
    const old = [msg(), msg()];
    const sealed = await Promise.all(old.map((m) => sealRow(m as never, STORE_SPECS.messages)));
    await new Promise<void>((resolve, reject) => {
      const open = indexedDB.open("awful-chat", 10);
      open.onupgradeneeded = () => {
        const store = open.result.createObjectStore("messages", { keyPath: "id" });
        store.createIndex("byRoom", "roomCode", { unique: false });
        store.createIndex("byRoomLamport", ["roomCode", "lamport"], { unique: false });
        store.createIndex("bySender", "senderId", { unique: false });
        for (const row of sealed) store.put(row);
      };
      open.onsuccess = () => { open.result.close(); resolve(); };
      open.onerror = () => reject(open.error);
    });

    const database = await getDB();
    expect(database.version).toBe(11);
    expect(database.transaction("messages").store.indexNames.contains("byRoomChannelLamport")).toBe(true);
    expect((await getMessages(ROOM, undefined, undefined, "")).map((m) => m.id)).toEqual(["m-0001", "m-0002"]);
    expect(await getMessages(ROOM, undefined, undefined, GAMES)).toEqual([]);

    await putMessage(msg({ channel: GAMES }));
    expect((await getMessages(ROOM, undefined, undefined, "")).map((m) => m.id)).toEqual(["m-0001", "m-0002"]);
    expect((await getMessages(ROOM, undefined, undefined, GAMES)).map((m) => m.id)).toEqual(["m-0003"]);

    // A channel row an older build stored (from a newer device's backup or
    // device sync): sealed with its channel inside but no index field. It
    // is not the original chat's, whatever its clear fields say.
    const { pairBlind: _unused, ...v10Spec } = STORE_SPECS.messages;
    const stray = await sealRow(msg({ channel: GAMES }) as never, v10Spec);
    expect("roomChannel" in stray).toBe(false);
    await database.put("messages", stray as never);
    expect((await getMessages(ROOM, undefined, undefined, "")).map((m) => m.id)).toEqual(["m-0001", "m-0002"]);

    // Not rewritten: the same sealed blob, IV and all, as before the upgrade.
    const after = (await database.getAll("messages")) as unknown as Array<{ id: string; _enc: { iv: Uint8Array } }>;
    for (const row of sealed as unknown as Array<{ id: string; _enc: { iv: Uint8Array } }>) {
      const now = after.find((r) => r.id === row.id)!;
      expect(new Uint8Array(now._enc.iv)).toEqual(new Uint8Array(row._enc.iv));
    }
  });
});
