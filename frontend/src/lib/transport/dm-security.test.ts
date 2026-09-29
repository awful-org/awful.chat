import { beforeEach, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { publicKeyToDid, type UnlockedSession } from "$lib/identity/identity";
import { pairwiseRoomSecret } from "$lib/room-security/pairwise";
import { hashDmRoomCode } from "./dm-codec";

const state = vi.hoisted(() => ({
  session: null as UnlockedSession | null,
  identity: { did: null as string | null },
  records: new Map<string, any>(), contacts: [] as any[], bindings: new Map<string, string>(),
  transport: { selfId: () => "12D3-local-device", peers: () => ["12D3-remote-device"],
    isRoomPeer: () => true, joinSecureConversation: vi.fn(), joinRoom: vi.fn(),
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
import { ensureDmRoomForPeer, joinPhonebookDmRooms, sendDmFrame, sendDirectMessage } from "./dm.svelte";

function identity(): UnlockedSession {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = new Uint8Array(ed25519.getPublicKey(privateKey));
  return { privateKey, publicKey, did: publicKeyToDid(publicKey) };
}
let remote: UnlockedSession;
beforeEach(() => {
  vi.clearAllMocks(); state.records.clear(); state.bindings.clear(); state.contacts = [];
  state.session = identity(); state.identity.did = state.session.did; remote = identity();
  state.bindings.set("12D3-remote-device", remote.did);
});
it("phonebook autojoin derives private capabilities while preserving database IDs", async () => {
  state.contacts = [{ did: remote.did, peerId: "12D3-remote-device" }];
  await joinPhonebookDmRooms();
  const local = await hashDmRoomCode(state.session!.did, remote.did);
  expect(state.transport.joinSecureConversation).toHaveBeenCalledWith(local,
    pairwiseRoomSecret(state.session!.privateKey, remote.publicKey));
  expect(state.records.get(local).participantDid).toBe(remote.did);
  expect(state.transport.joinRoom).not.toHaveBeenCalled();
});
it("live text and batch delivery use only the protected local DM scope", async () => {
  await sendDirectMessage("hello", { peerId: "12D3-remote-device" });
  const local = await hashDmRoomCode(state.session!.did, remote.did);
  expect(state.transport.sendRoom).toHaveBeenCalledWith("12D3-remote-device", local, expect.any(Uint8Array));
  await sendDmFrame("12D3-remote-device", new Uint8Array([5]));
  expect(state.transport.sendRoom).toHaveBeenLastCalledWith("12D3-remote-device", local, new Uint8Array([5]));
  expect(state.transport.send).not.toHaveBeenCalled();
  expect(state.transport.joinRoom).not.toHaveBeenCalled();
});
it("does not bind or send a room after locking during an asynchronous lookup", async () => {
  const pending = ensureDmRoomForPeer(remote.did);
  state.session = null;
  await expect(pending).rejects.toThrow();
  expect(state.transport.joinSecureConversation).not.toHaveBeenCalled();
  expect(await sendDmFrame("12D3-remote-device", new Uint8Array([1]))).toBe(false);
  expect(state.transport.sendRoom).not.toHaveBeenCalled();
});
