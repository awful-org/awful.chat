import { beforeEach, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { publicKeyToDid, type UnlockedSession } from "$lib/identity/identity";

// Deleting a conversation through the real dm.svelte and the real storage
// (fake IndexedDB); only the transport around them is stood in for.
const state = vi.hoisted(() => ({
  session: null as UnlockedSession | null,
  identity: { did: null as string | null },
}));
vi.mock("$lib/identity/identity", async (original) => ({
  ...await original<typeof import("$lib/identity/identity")>(),
  requireSession: () => { if (!state.session) throw new Error("Locked"); return state.session; },
}));
vi.mock("$lib/identity/identity.svelte", () => ({ identityStore: state.identity }));
vi.mock("$lib/rooms.svelte", () => ({ refreshDmRooms: async () => {}, roomsStore: { phonebook: [], dmRooms: [] } }));
vi.mock("$lib/search/corpus.svelte", () => ({ dropRoomCorpus: vi.fn() }));
vi.mock("./call.svelte", () => ({ leaveCall: vi.fn() }));
vi.mock("./files.svelte", () => ({ _hydrateAndSeedAttachments: vi.fn() }));
vi.mock("$lib/messaging", () => ({ signMessage: (m: unknown) => m }));
vi.mock("./transport.svelte", () => ({
  _transport: { peers: () => [], forgetConversation: vi.fn() },
  _peerIdToDid: new Map(),
  peerIdToDid: (id: string) => id,
  transportState: { messages: [], dmVersion: 0, chatMode: "room", activeDmPeerId: null },
  appendSorted: (a: unknown[], b: unknown) => [...a, b],
  beginConversationOpen: () => () => true,
}));
import { removeDmConversation } from "./dm.svelte";
import { hashDmRoomCode } from "./dm-codec";
import {
  getDeletedFloor,
  holdWatermarks,
  putRoom,
  setWatermark,
  wipeLocalDatabase,
} from "$lib/storage";

function identity(): UnlockedSession {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = new Uint8Array(ed25519.getPublicKey(privateKey));
  return { privateKey, publicKey, did: publicKeyToDid(publicKey) };
}

let remote: UnlockedSession;
let room: string;
beforeEach(async () => {
  await wipeLocalDatabase();
  state.session = identity();
  state.identity.did = state.session.did;
  remote = identity();
  room = await hashDmRoomCode(state.session.did, remote.did);
  await putRoom({ roomCode: room, type: "dm", name: "", participantDid: remote.did,
    lastSeenLamport: 0, createdAt: 1, participants: [] });
});

// The floor keeps a deleted conversation deleted: a relay replaying blobs we
// acked must not bring it back. A DM that arrived while the conversation was
// held - a digest unanswered, a push open - is stored, but its watermark
// waits in memory until the hold ends.
it("counts a DM that arrived while the conversation was held in its deleted floor", async () => {
  await setWatermark(room, remote.did, 5);
  holdWatermarks(room);
  await setWatermark(room, remote.did, 9);
  await removeDmConversation(remote.did);
  expect(await getDeletedFloor(room, remote.did)).toBe(9);
});

it("writes a floor for a conversation whose every DM arrived while it was held", async () => {
  holdWatermarks(room);
  await setWatermark(room, remote.did, 4);
  await removeDmConversation(remote.did);
  expect(await getDeletedFloor(room, remote.did)).toBe(4);
});
