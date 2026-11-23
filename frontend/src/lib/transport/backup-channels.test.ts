import { describe, expect, it } from "vitest";
import type { Room } from "../storage";
import { isValidMessageRecord, mergeImportedRoom, sanitizeCollections, sanitizeRoomChannels } from "./backup";
import { MAX_CHANNEL_FUTURE_MS, type Channel } from "../channels";
import { MessageType } from "../types/message";

// A room's channels in a backup or a device sync: merged by the same rule
// members merge announcements by, and every field checked on the way in.

const NOW = 1_800_000_000_000;
const GAMES = "gamesgames";
const MUSIC = "musicmusic";
const ART = "artartart0";

const entry = (id: string, over: Partial<Channel> = {}): Channel => ({
  id, kind: "text", name: id.slice(0, 5), position: 1, updatedAt: NOW - 100, ...over,
});

const local = {
  roomCode: "abc", type: "text" as const, name: "Room", lastSeenLamport: 5, createdAt: 1,
  participants: [], participantLastSeen: {},
} as Room;

describe("merging an imported room's channels", () => {
  it("merges the lists entry by entry, never taking either side whole", () => {
    const here: Room = {
      ...local,
      channels: [entry(GAMES, { name: "games", updatedAt: NOW - 10 }), entry(MUSIC)],
    };
    const there: Room = {
      ...local,
      channels: [
        entry(GAMES, { name: "older", updatedAt: NOW - 50 }),
        { ...entry(MUSIC, { updatedAt: NOW - 5 }), deleted: true },
        entry(ART),
      ],
    };
    const merged = mergeImportedRoom(here, there, NOW);
    const byId = new Map(merged.channels!.map((c) => [c.id, c]));
    expect(byId.get(GAMES)?.name).toBe("games"); // ours is newer
    expect(byId.get(MUSIC)?.deleted).toBe(true); // their delete is newer
    expect(byId.has(ART)).toBe(true); // only they had it
    // The same answer from either side.
    expect(mergeImportedRoom(there, here, NOW).channels).toEqual(merged.channels);
  });

  it("drops an imported entry stamped past our clock, and junk", () => {
    const there = {
      ...local,
      channels: [entry(GAMES, { updatedAt: NOW + MAX_CHANNEL_FUTURE_MS + 1 }), { id: "x" }, "junk"],
    } as unknown as Room;
    expect(mergeImportedRoom(local, there, NOW)).not.toHaveProperty("channels");
  });

  it("moves read marks forward only and unions pins, per channel", () => {
    const here: Room = { ...local, channelSeen: { [GAMES]: 9 }, channelPins: { [GAMES]: ["a"] } };
    const there: Room = {
      ...local,
      channelSeen: { [GAMES]: 4, [MUSIC]: 7 },
      channelPins: { [GAMES]: ["b", "a"], [MUSIC]: ["c"] },
    };
    const merged = mergeImportedRoom(here, there, NOW);
    expect(merged.channelSeen).toEqual({ [GAMES]: 9, [MUSIC]: 7 });
    expect(merged.channelPins).toEqual({ [GAMES]: ["a", "b"], [MUSIC]: ["c"] });
  });

  it("leaves a room nobody made a channel in exactly as it was", () => {
    const merged = mergeImportedRoom(local, { ...local }, NOW);
    expect(merged).not.toHaveProperty("channels");
    expect(merged).not.toHaveProperty("channelSeen");
    expect(merged).not.toHaveProperty("channelPins");
  });
});

describe("checking imported records", () => {
  const base = { messages: [], attachments: [], pending: [], watermarks: [], yjsDocs: [], rooms: [], profiles: [], savedGifs: [] };
  const message = (over: Record<string, unknown> = {}) => ({
    id: "m1", roomCode: "rd2_a", senderId: "did:key:a", type: MessageType.Text, lamport: 1, content: "x", ...over,
  });

  it("refuses a message with a malformed channel, or a channel in a DM", () => {
    expect(isValidMessageRecord(message())).toBe(true);
    expect(isValidMessageRecord(message({ channel: GAMES }))).toBe(true);
    for (const channel of ["", "NOPE", 5, null]) {
      expect(isValidMessageRecord(message({ channel }))).toBe(false);
    }
    expect(isValidMessageRecord(message({ roomCode: "dm-x", channel: GAMES }))).toBe(false);
  });

  it("keeps and merges where an original was moved to", () => {
    const moved = entry("", { name: "general", position: 3, updatedAt: NOW - 1 });
    expect(sanitizeRoomChannels({ ...local, channels: [moved, entry(GAMES)] }).channels).toContainEqual(moved);
    const bad = [{ ...moved, position: "3" }, { ...moved, kind: "voice", deleted: true }] as unknown as Channel[];
    expect(sanitizeRoomChannels({ ...local, channels: bad })).not.toHaveProperty("channels");
    const renamed = entry("", { name: "lobby", position: 0, updatedAt: NOW - 5 });
    const merged = mergeImportedRoom({ ...local, channels: [renamed] }, { ...local, channels: [moved] }, NOW);
    expect(merged.channels).toEqual([moved]);
  });

  it("keeps a room whose channel fields are partly bad, with only the good parts", () => {
    const room = {
      ...local,
      channels: [entry(GAMES), { ...entry(MUSIC), kind: "video" }, null],
      channelSeen: { [GAMES]: 3, "NOT AN ID": 4, [MUSIC]: -1 },
      channelPins: { [GAMES]: ["a", 7, ""], bad: ["b"] },
    };
    const dm = { ...local, roomCode: "dm-x", type: "dm", channels: [entry(GAMES)] };
    const result = sanitizeCollections({ ...base, rooms: [room, dm] });
    expect(result.dropped).toBe(0);
    const [kept, keptDm] = result.rooms;
    expect(kept.channels?.map((c) => c.id)).toEqual([GAMES]);
    expect(kept.channelSeen).toEqual({ [GAMES]: 3 });
    expect(kept.channelPins).toEqual({ [GAMES]: ["a"] });
    expect(keptDm).not.toHaveProperty("channels");
  });
});
