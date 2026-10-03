import { beforeEach, describe, expect, it, vi } from "vitest";

// The host API wants the transport, voice and UI modules; none of them is
// what this measures. Storage, its at-rest crypto, the card-state store and
// the Apps reducer are all the real thing.
vi.mock("$lib/transport/transport.svelte", () => ({
  transportState: { roomCode: "room-x", fileTransfers: new Map(), peers: [], peerNames: new Map() },
  onBeforeDisconnect: vi.fn(),
  onPeerDisconnect: vi.fn(),
}));
vi.mock("$lib/identity/identity.svelte", () => ({ identityStore: { did: "did:key:zVictim" } }));
vi.mock("$lib/ui-state.svelte", () => ({}));
vi.mock("./media-session", () => ({}));
vi.mock("./local-cards.svelte", () => ({ closeLocalCard: vi.fn(), upsertLocalCard: vi.fn() }));
vi.mock("$lib/transport/voice.svelte", () => ({
  getCallAudioBlockedReason: vi.fn(), getCallCaptureBlockedReason: vi.fn(),
  getCallCaptureStreams: vi.fn(), onCallCaptureChange: vi.fn(),
  playCallAudio: vi.fn(), stopCallAudio: vi.fn(),
}));
vi.mock("$lib/audio/call-audio-mixer", () => ({ CALL_SOUND_MAX_DURATION_MS: 1000 }));
vi.mock("./registry", () => ({ getPlugin: async (id: string) => (id === "app" ? app : null) }));

import { bulkPutMessages, getDB } from "$lib/storage";
import { MessageType, type Message } from "$lib/types/message";
import { initialState, reduce } from "../../../plugins/app/logic";
import type { PluginDefinition } from "./api";
import { makeHostApi } from "./host";
import { cardStates, clearCardStates, getCardState, onCardStateChange } from "./state.svelte";

const app = { manifest: { id: "app" }, initialState, reduce } as unknown as PluginDefinition;
const ROOM = "room-x";
const MALLORY = "did:key:zMallory";
const VICTIM = "did:key:zVictim";

const wholeRoomReads = vi.spyOn(IDBIndex.prototype, "getAll");
const decrypts = vi.spyOn(crypto.subtle, "decrypt");

let seq = 0;
function msg(type: MessageType, senderId: string, content: string): Message {
  seq += 1;
  return {
    id: `m-${String(seq).padStart(6, "0")}`,
    roomCode: ROOM,
    senderId,
    senderName: "x",
    timestamp: seq,
    lamport: seq,
    type,
    content,
    attachments: [],
  } as Message;
}
const appCard = (sender: string) =>
  msg(
    MessageType.PluginCard,
    sender,
    JSON.stringify({
      pluginId: "app",
      data: { url: "https://je.frav.in/", sessionId: `s_${seq}abcdefgh`, salt: "saltsaltsaltsalt", args: "" },
    })
  );

/**
 * What AppCard used to do - ask on mount and on every card-state tick until
 * answered. It reads the call tiles' answer now; any plugin may still call
 * host.cards() this way, so it has to stay cheap when one does.
 */
function mountAppCard(host: ReturnType<typeof makeHostApi>, cardId: string, calls: { n: number }) {
  let answered = false;
  let off = () => {};
  const check = () => {
    if (answered) return;
    calls.n += 1;
    void host.cards().then((cards) => {
      answered = true;
      void (cards.length > 0 && cards[cards.length - 1].id !== cardId);
      off();
    });
  };
  check();
  off = onCardStateChange(check);
}

async function settle(): Promise<void> {
  for (let i = 0; i < 40; i++) await new Promise((r) => setTimeout(r, 5));
}

beforeEach(async () => {
  await (await getDB()).clear("messages");
  clearCardStates();
});

// S10.1: a member of a room posts K app cards. Every member's room open
// rebuilt every app card, each from a whole-room read, and every rebuild
// woke every card on screen to ask again - K full reads and K*K decrypts
// per room open, and K*M more reads from the cards asking.
describe("a room full of one member's app cards", () => {
  it("opens with one read of the room and one decrypt per row", async () => {
    const K = 150;
    const rows: Message[] = [];
    for (let i = 0; i < 200; i++) rows.push(msg(MessageType.Text, MALLORY, `chat ${i}`));
    for (let i = 0; i < 3; i++) rows.push(appCard(VICTIM));
    for (let i = 0; i < K; i++) rows.push(appCard(MALLORY));
    await bulkPutMessages(rows);
    const cards = rows.filter((r) => r.type === MessageType.PluginCard);
    wholeRoomReads.mockClear();
    decrypts.mockClear();

    // A room open: the newest page's cards build their state, as MsgRender
    // does, and each card asks the host for the room's app cards.
    const host = makeHostApi("app", ROOM);
    const onScreen = cards.slice(-50);
    const calls = { n: 0 };
    await Promise.all(
      onScreen.map(async (card) => {
        await getCardState(card.id, ROOM, app);
        mountAppCard(host, card.id, calls);
      })
    );
    await settle();

    // One read of the room (two index reads while the blinding sweep is
    // pending, as it is in tests), however many cards are on screen.
    expect(wholeRoomReads.mock.calls.length).toBeLessThanOrEqual(2);
    // Each card row decrypted once - not once per card that was built.
    expect(decrypts.mock.calls.length).toBeLessThanOrEqual(cards.length);
    // The host folded the cards on screen and the user's own, not all K.
    expect(cardStates.size).toBeLessThanOrEqual(onScreen.length + 3);
    // ... however often the cards asked: every one did, most several times.
    expect(calls.n).toBeGreaterThan(onScreen.length);

    // Showing the same cards again costs nothing: their states and the
    // room's rows are held (and entering a room no longer drops them).
    wholeRoomReads.mockClear();
    decrypts.mockClear();
    await Promise.all(onScreen.map((card) => getCardState(card.id, ROOM, app)));
    expect(wholeRoomReads).not.toHaveBeenCalled();
    expect(decrypts).not.toHaveBeenCalled();
  });

  it("still gives /app the state of the user's own earlier apps", async () => {
    const mine = appCard(VICTIM);
    const theirs = appCard(MALLORY);
    await bulkPutMessages([mine, theirs]);
    const listed = await makeHostApi("app", ROOM).cards();
    expect(listed.map((c) => c.id)).toEqual([mine.id, theirs.id]);
    expect(listed[0].state).toMatchObject({ starter: VICTIM, ended: false });
    // Someone else's card the host does not hold: no fold for it.
    expect(listed[1].state).toBeUndefined();
    expect(cardStates.has(theirs.id)).toBe(false);
  });
});
