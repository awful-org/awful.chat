import { beforeEach, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { publicKeyToDid, type UnlockedSession } from "$lib/identity/identity";
import { derivePqKemKeypair } from "$lib/identity/pq-identity";
import { pairwiseRoomSecret } from "$lib/room-security/pairwise";
import { deriveRoomKeys } from "$lib/room-security/keys";
import { dmPqEncapsulate, dmPqRole, hybridPairwiseRoomSecret, type DmPqState } from "$lib/room-security/pq-dm";
import { hashDmRoomCode } from "./dm-codec";

const state = vi.hoisted(() => ({
  session: null as UnlockedSession | null,
  identity: { did: null as string | null },
  records: new Map<string, any>(), contacts: [] as any[], bindings: new Map<string, string>(),
  transport: { selfId: () => "12D3-local-device", peers: () => ["12D3-remote-device"],
    isRoomPeer: () => true, joinSecureConversation: vi.fn(), holdDmLobby: vi.fn(), joinRoom: vi.fn(),
    introduceDm: vi.fn(async () => true), sendRoom: vi.fn(async () => true), send: vi.fn(), },
}));
vi.mock("$lib/identity/identity", async (original) => ({
  ...await original<typeof import("$lib/identity/identity")>(),
  requireSession: () => { if (!state.session) throw new Error("Locked"); return state.session; },
}));
vi.mock("$lib/identity/identity.svelte", () => ({ identityStore: state.identity }));
vi.mock("$lib/rooms.svelte", () => ({ refreshDmRooms: async () => {}, roomsStore: { phonebook: [] } }));
vi.mock("$lib/search/corpus.svelte", () => ({ dropRoomCorpus: vi.fn() }));
vi.mock("./call.svelte", () => ({ leaveCall: vi.fn() }));
vi.mock("./files.svelte", () => ({ _hydrateAndSeedAttachments: vi.fn() }));
vi.mock("$lib/messaging", () => ({ signMessage: (m: unknown) => m }));
vi.mock("$lib/storage", () => ({
  getRoom: async (room: string) => state.records.get(room),
  putRoom: async (room: any) => { state.records.set(room.roomCode, room); },
  setDmPqState: async (room: string, pq: DmPqState) => {
    const record = state.records.get(room);
    if (!record) return false;
    state.records.set(room, { ...record, pq });
    return true;
  },
  getPhonebookEntries: async () => state.contacts,
  nextDmLamport: async () => 1, putMessage: async () => {},
  setWatermark: async () => {}, markRoomSeen: async () => {},
}));
vi.mock("./transport.svelte", () => ({
  _transport: state.transport, _peerIdToDid: state.bindings,
  transportState: { messages: [], dmVersion: 0, dmQueuedP2POnly: new Set() },
  appendSorted: (a: unknown[], b: unknown) => [...a, b],
  beginConversationOpen: () => () => true,
}));
import { ensureDmRoomForPeer, offerDmUpgrade } from "./dm.svelte";

function identity(): UnlockedSession {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = new Uint8Array(ed25519.getPublicKey(privateKey));
  return { privateKey, publicKey, did: publicKeyToDid(publicKey) };
}
let remote: UnlockedSession;
let local: string;
/** The state an introduction would have agreed, from whichever side encapsulates. */
function agreed(): DmPqState {
  const self = state.session!;
  return dmPqRole(self.privateKey, remote.publicKey) === "encapsulator"
    ? dmPqEncapsulate(self.privateKey, remote.publicKey, derivePqKemKeypair(remote.privateKey).publicKey)
    : dmPqEncapsulate(remote.privateKey, self.publicKey, derivePqKemKeypair(self.privateKey).publicKey);
}
beforeEach(async () => {
  vi.clearAllMocks(); state.records.clear(); state.bindings.clear();
  state.session = identity(); state.identity.did = state.session.did; remote = identity();
  state.bindings.set("12D3-remote-device", remote.did);
  local = await hashDmRoomCode(state.session.did, remote.did);
});

it("moves an existing classical DM onto the agreed hybrid key, keeping its room", async () => {
  await ensureDmRoomForPeer(remote.did);
  const classical = pairwiseRoomSecret(state.session!.privateKey, remote.publicKey);
  expect(state.transport.joinSecureConversation).toHaveBeenLastCalledWith(local, classical);
  const pq = agreed();
  expect(await ensureDmRoomForPeer(remote.did, pq)).toBe(local);
  expect(state.records.get(local).pq).toEqual(pq);
  expect(state.transport.joinSecureConversation).toHaveBeenLastCalledWith(local,
    hybridPairwiseRoomSecret(state.session!.privateKey, remote.publicKey, pq), classical);
  // Every later join - a send, a restart - stays on the hybrid key.
  await ensureDmRoomForPeer(remote.did);
  expect(state.transport.joinSecureConversation).toHaveBeenLastCalledWith(local,
    hybridPairwiseRoomSecret(state.session!.privateKey, remote.publicKey, pq), classical);
});

it("creates a new DM already post-quantum", async () => {
  const pq = agreed();
  await ensureDmRoomForPeer(remote.did, pq);
  expect(state.records.get(local)).toMatchObject({ roomCode: local, participantDid: remote.did, pq });
  const calls = state.transport.joinSecureConversation.mock.calls;
  expect(calls).toHaveLength(1);
  expect(calls[0][2]).toBe(pairwiseRoomSecret(state.session!.privateKey, remote.publicKey));
});

it("refuses a state that does not belong to this conversation, changing nothing", async () => {
  await ensureDmRoomForPeer(remote.did);
  const other = identity();
  const foreign = dmPqRole(other.privateKey, remote.publicKey) === "encapsulator"
    ? dmPqEncapsulate(other.privateKey, remote.publicKey, derivePqKemKeypair(remote.privateKey).publicKey)
    : dmPqEncapsulate(remote.privateKey, other.publicKey, derivePqKemKeypair(other.privateKey).publicKey);
  state.transport.joinSecureConversation.mockClear();
  await expect(ensureDmRoomForPeer(remote.did, foreign)).rejects.toThrow();
  expect(state.records.get(local).pq).toBeUndefined();
  expect(state.transport.joinSecureConversation).not.toHaveBeenCalled();
});

it("fails closed on an unusable stored state: lobby only, never the classical key", async () => {
  await ensureDmRoomForPeer(remote.did);
  const good = agreed();
  state.records.set(local, { ...state.records.get(local), pq: { ...good, ek: good.ek.replace(/^./, good.ek[0] === "A" ? "B" : "A") } });
  state.transport.joinSecureConversation.mockClear();
  await expect(ensureDmRoomForPeer(remote.did)).rejects.toThrow("post-quantum");
  expect(state.transport.joinSecureConversation).not.toHaveBeenCalled();
  expect(state.transport.holdDmLobby).toHaveBeenCalledWith(local,
    deriveRoomKeys(pairwiseRoomSecret(state.session!.privateKey, remote.publicKey)).discoveryId);
});

it("offers the upgrade only for a classical DM that exists, and not twice in a row", async () => {
  await offerDmUpgrade("12D3-first-device", remote.did);
  expect(state.transport.introduceDm).not.toHaveBeenCalled(); // no DM with them
  await ensureDmRoomForPeer(remote.did);
  state.transport.introduceDm.mockClear();
  await offerDmUpgrade("12D3-remote-device", remote.did);
  expect(state.transport.introduceDm).toHaveBeenCalledExactlyOnceWith("12D3-remote-device", remote.did);
  await offerDmUpgrade("12D3-remote-device", remote.did);
  expect(state.transport.introduceDm).toHaveBeenCalledTimes(1);
  // Already post-quantum: nothing to offer.
  await ensureDmRoomForPeer(remote.did, agreed());
  await offerDmUpgrade("12D3-other-device", remote.did);
  expect(state.transport.introduceDm).toHaveBeenCalledTimes(1);
  // Never to ourselves.
  await offerDmUpgrade("12D3-own-device", state.session!.did);
  expect(state.transport.introduceDm).toHaveBeenCalledTimes(1);
});
