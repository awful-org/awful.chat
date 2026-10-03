import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("./registry", () => ({
  getPlugin: async (id: string) => (id === "app" ? app : null),
  getManifest: (id: string) => (id === "app" ? { id } : null),
}));
vi.mock("./prefs.svelte", () => ({ isPluginEnabled: () => true }));
// The real storage, except that a test can make the next card scans fail.
const failScans = vi.hoisted(() => ({ left: 0 }));
vi.mock("$lib/storage", async (importOriginal) => {
  const real = await importOriginal<typeof import("$lib/storage")>();
  return {
    ...real,
    getPluginCardMessages: (...args: Parameters<typeof real.getPluginCardMessages>) =>
      failScans.left-- > 0
        ? Promise.reject(new Error("storage hiccup"))
        : real.getPluginCardMessages(...args),
  };
});

import { bulkPutMessages, getDB, putMessage } from "$lib/storage";
import { MessageType, type ChatMessageType, type Message } from "$lib/types/message";
import { initialState, presentPlayers, reduce, type AppState } from "../../../plugins/app/logic";
import type { PluginDefinition } from "./api";
import { callTilesState, newestCardOf, refreshCallTiles, watchRoomCards } from "./call-tiles.svelte";
import { clearCardStates, foldUpdate } from "./state.svelte";
import { notifyIdentityLock } from "$lib/identity/lock-events";

// The Apps plugin as the host sees it: the real reducer, its tile hooks.
const app = {
  manifest: { id: "app" },
  callTile: {},
  initialState,
  reduce,
  callTileActive: (s: AppState) => !s.ended && !!s.url,
  callTileViewers: (s: AppState) => presentPlayers(s).map((p) => p.name),
} as unknown as PluginDefinition;

const ROOM = "room-call";
const wholeRoomReads = vi.spyOn(IDBIndex.prototype, "getAll");
const countChecks = vi.spyOn(IDBIndex.prototype, "count");

let seq = 0;
function msg(type: ChatMessageType, content: string): Message {
  seq += 1;
  return {
    id: `c-${String(seq).padStart(6, "0")}`,
    roomCode: ROOM,
    senderId: "did:key:zAna",
    senderName: "Ana",
    timestamp: seq,
    lamport: seq,
    type,
    content,
    attachments: [],
  };
}
const appCard = () =>
  msg(
    MessageType.PluginCard,
    JSON.stringify({
      pluginId: "app",
      data: { url: "https://je.frav.in/", sessionId: `s_${seq}abcdefgh`, salt: "saltsaltsaltsalt", args: "" },
    })
  );
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

beforeEach(async () => {
  failScans.left = 0;
  refreshCallTiles(null);
  await (await getDB()).clear("messages");
  clearCardStates();
});

describe("which card of each plugin is the newest", () => {
  it("is read from storage only when a card is stored", async () => {
    const first = appCard();
    const second = appCard();
    const chat = Array.from({ length: 30 }, (_, i) => msg(MessageType.Text, `hi ${i}`));
    await bulkPutMessages([first, second, ...chat]);
    const off = watchRoomCards(ROOM);
    await vi.waitFor(() => expect(newestCardOf(ROOM, "app")).toBe(second.id));

    // Chat in the room is nothing to look at.
    wholeRoomReads.mockClear();
    countChecks.mockClear();
    await putMessage(msg(MessageType.Text, "and another"));
    await sleep(50);
    expect(countChecks).not.toHaveBeenCalled();
    expect(wholeRoomReads).not.toHaveBeenCalled();

    // A newer card moves the answer, from the rows storage already holds.
    const third = appCard();
    await putMessage(third);
    await vi.waitFor(() => expect(newestCardOf(ROOM, "app")).toBe(third.id));
    expect(wholeRoomReads).not.toHaveBeenCalled();

    off();
    expect(newestCardOf(ROOM, "app")).toBeUndefined();
  });

  it("forgets cards that are gone when a room is watched again", async () => {
    const card = appCard();
    await putMessage(card);
    const off = watchRoomCards(ROOM);
    await vi.waitFor(() => expect(newestCardOf(ROOM, "app")).toBe(card.id));
    off();
    await (await getDB()).clear("messages");
    const again = watchRoomCards(ROOM);
    await sleep(50);
    expect(newestCardOf(ROOM, "app")).toBeUndefined();
    again();
  });
});

// P02.1 / G05.2: in a call, every tick - a vote, a chat line, each open
// app's 15 s heartbeat from each other player - re-read the call room's
// whole stored history.
describe("the call's tiles", () => {
  it("follow every fold from held state, with no storage at all", async () => {
    const card = appCard();
    await bulkPutMessages([card, ...Array.from({ length: 30 }, (_, i) => msg(MessageType.Text, `${i}`))]);
    refreshCallTiles(ROOM);
    await vi.waitFor(() => expect(callTilesState.tiles.map((t) => t.cardId)).toEqual([card.id]));

    wholeRoomReads.mockClear();
    countChecks.mockClear();
    // Twelve heartbeats from another player, each a fold and a tick the
    // stage answers with a refresh.
    for (let i = 0; i < 12; i++) {
      foldUpdate(card.id, app, {
        id: `here-${i}`,
        senderId: "did:key:zBo",
        senderDid: "did:key:zBo",
        senderName: "Bo",
        lamport: 0,
        data: { t: "here" },
        ephemeral: true,
        roomCode: ROOM,
      });
      refreshCallTiles(ROOM);
      await sleep(5);
    }
    await vi.waitFor(() => expect(callTilesState.tiles[0]?.viewers).toEqual(["Bo"]));
    expect(wholeRoomReads).not.toHaveBeenCalled();
    expect(countChecks).not.toHaveBeenCalled();

    // Nothing changed: the same tiles, not a new array for everything that
    // reads them to redo.
    const before = callTilesState.tiles;
    refreshCallTiles(ROOM);
    await sleep(400);
    expect(callTilesState.tiles).toBe(before);
  });

  it("move to a newer card stored in the call room, and an ended one takes none", async () => {
    const first = appCard();
    await putMessage(first);
    refreshCallTiles(ROOM);
    await vi.waitFor(() => expect(callTilesState.tiles.map((t) => t.cardId)).toEqual([first.id]));

    const second = appCard();
    await putMessage(second);
    await vi.waitFor(() => expect(callTilesState.tiles.map((t) => t.cardId)).toEqual([second.id]));

    // Ending the newest leaves no tile: an older running app does not come back.
    const end = msg(MessageType.PluginUpdate, JSON.stringify({ pluginId: "app", cardId: second.id, data: { t: "end" } }));
    await putMessage(end);
    foldUpdate(second.id, app, {
      id: end.id,
      senderId: end.senderId,
      senderName: end.senderName,
      lamport: end.lamport,
      data: { t: "end" },
      roomCode: ROOM,
    });
    refreshCallTiles(ROOM);
    await vi.waitFor(() => expect(callTilesState.tiles).toEqual([]));
  });

  it("try again on the next tick when the first look at the room failed", async () => {
    const card = appCard();
    await putMessage(card);
    failScans.left = 1;
    refreshCallTiles(ROOM);
    await sleep(400);
    expect(callTilesState.tiles).toEqual([]);
    refreshCallTiles(ROOM);
    await vi.waitFor(() => expect(callTilesState.tiles.map((t) => t.cardId)).toEqual([card.id]));
  });

  it("go with the session, room codes and all", async () => {
    await putMessage(appCard());
    refreshCallTiles(ROOM);
    await vi.waitFor(() => expect(callTilesState.tiles).toHaveLength(1));
    notifyIdentityLock();
    expect(callTilesState.tiles).toEqual([]);
    expect(newestCardOf(ROOM, "app")).toBeUndefined();
  });

  it("go with the call", async () => {
    await putMessage(appCard());
    refreshCallTiles(ROOM);
    await vi.waitFor(() => expect(callTilesState.tiles).toHaveLength(1));
    refreshCallTiles(null);
    expect(callTilesState.tiles).toEqual([]);
    expect(newestCardOf(ROOM, "app")).toBeUndefined();
  });
});
