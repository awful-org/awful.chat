import { beforeEach, expect, it } from "vitest";
import { putMessage, wipeLocalDatabase } from "$lib/storage";
import { initStorageCrypto } from "$lib/storage-crypto";
import { MessageType, type Message } from "$lib/types/message";
import { clearSearchCorpus, ensureRoomCorpus, searchRooms } from "./corpus.svelte";
import { parseSearchQuery } from "./query";

// Search scoped to one channel (channels.ts): a filter over the room's
// corpus, which stays one per room and keeps each entry's channel.

const GAMES = "gamesgames";
let seq = 0;
function msg(content: string, channel?: string): Message {
  seq += 1;
  return {
    id: `msg-${seq}`, roomCode: "room-a", senderId: "a", senderDid: "did:key:a", senderName: "A",
    timestamp: Date.now() - 1000 + seq, lamport: seq, type: MessageType.Text, content,
    attachments: [], ...(channel ? { channel } : {}),
  };
}

beforeEach(async () => {
  await initStorageCrypto(new Uint8Array(32).fill(7));
  await wipeLocalDatabase();
  clearSearchCorpus();
  seq = 0;
});

it("finds a room's messages in every channel, or in the one asked for", async () => {
  await putMessage(msg("needle in general"));
  await putMessage(msg("needle in games", GAMES));
  await ensureRoomCorpus("room-a");
  const q = parseSearchQuery("needle");
  expect(searchRooms(q, ["room-a"])).toHaveLength(2);
  const games = searchRooms(q, ["room-a"], 80, Date.now(), GAMES);
  expect(games.map((h) => [h.entry.text, h.entry.channel])).toEqual([["needle in games", GAMES]]);
  const general = searchRooms(q, ["room-a"], 80, Date.now(), "");
  expect(general.map((h) => h.entry.text)).toEqual(["needle in general"]);
  expect(general[0].entry).not.toHaveProperty("channel");
});

it("keeps the channel through the sealed index a later session reads", async () => {
  await putMessage(msg("needle", GAMES));
  await ensureRoomCorpus("room-a");
  clearSearchCorpus();
  await ensureRoomCorpus("room-a");
  const hits = searchRooms(parseSearchQuery("needle"), ["room-a"], 80, Date.now(), GAMES);
  expect(hits).toHaveLength(1);
});
