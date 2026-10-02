import { beforeEach, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { publicKeyToDid, type UnlockedSession } from "$lib/identity/identity";
import { hashDmRoomCode } from "./dm-codec";

const state = vi.hoisted(() => ({
  session: null as UnlockedSession | null,
  identity: { did: null as string | null },
  records: new Map<string, any>(), contacts: [] as any[], rooms: [] as any[],
  bindings: new Map<string, string>(), roomReads: 0,
  transport: { selfId: () => "12D3-local-device", peers: () => [],
    isRoomPeer: () => true, joinSecureConversation: vi.fn(), joinRoom: vi.fn(),
    introduceDm: vi.fn(async () => true), sendRoom: vi.fn(async () => true), send: vi.fn(), },
}));
vi.mock("$lib/identity/identity", async (original) => ({
  ...await original<typeof import("$lib/identity/identity")>(),
  requireSession: () => { if (!state.session) throw new Error("Locked"); return state.session; },
}));
vi.mock("$lib/identity/identity.svelte", () => ({ identityStore: state.identity }));
vi.mock("$lib/rooms.svelte", () => ({
  refreshDmRooms: async () => {},
  roomsStore: { phonebook: [], dmRooms: [] },
}));
vi.mock("$lib/search/corpus.svelte", () => ({ dropRoomCorpus: vi.fn() }));
vi.mock("./call.svelte", () => ({ leaveCall: vi.fn() }));
vi.mock("./files.svelte", () => ({ _hydrateAndSeedAttachments: vi.fn() }));
vi.mock("$lib/messaging", () => ({ signMessage: (m: unknown) => m }));
vi.mock("$lib/storage", () => ({
  getRoom: async (room: string) => state.records.get(room),
  putRoom: async (room: any) => { state.records.set(room.roomCode, room); },
  getAllRooms: async () => { state.roomReads++; return [...state.rooms, ...state.records.values()]; },
  getDMRooms: async () => [...state.records.values()],
  setDmRequest: async (roomCode: string, request: boolean) => {
    const room = state.records.get(roomCode);
    if (!room || (room.request === true) === request) return false;
    state.records.set(roomCode, { ...room, request });
    return true;
  },
  getPhonebookEntries: async () => state.contacts,
  getLastMessage: async () => undefined,
  nextDmLamport: async () => 1, putMessage: async () => {},
  setWatermark: async () => {}, markRoomSeen: async () => {},
}));
vi.mock("./transport.svelte", () => ({
  _transport: state.transport, _peerIdToDid: state.bindings,
  transportState: { messages: [], dmVersion: 0, dmQueuedP2POnly: new Set() },
  appendSorted: (a: unknown[], b: unknown) => [...a, b],
  beginConversationOpen: () => () => true,
}));
import {
  MAX_DM_REQUESTS,
  acceptDmRequest,
  ensureDmRoomForPeer,
  sendDirectMessage,
} from "./dm.svelte";

function identity(): UnlockedSession {
  const privateKey = crypto.getRandomValues(new Uint8Array(32));
  const publicKey = new Uint8Array(ed25519.getPublicKey(privateKey));
  return { privateKey, publicKey, did: publicKeyToDid(publicKey) };
}
const room = (did: string) => hashDmRoomCode(state.session!.did, did);

beforeEach(() => {
  vi.clearAllMocks();
  state.records.clear(); state.bindings.clear(); state.contacts = []; state.rooms = [];
  // A fresh identity per test also gives each test its own "reached out to"
  // set: nobody here has been messaged by this session yet.
  state.session = identity(); state.identity.did = state.session.did;
});

it("files a stranger's new conversation as a request", async () => {
  const stranger = identity().did;
  const code = await ensureDmRoomForPeer(stranger, undefined, { unsolicited: true });
  expect(code).toBe(await room(stranger));
  expect(state.records.get(code!).request).toBe(true);
});

it("a contact's or roommate's conversation is never a request", async () => {
  const contact = identity().did, roommate = identity().did;
  state.contacts = [{ did: contact, peerId: "12D3-contact" }];
  state.rooms = [{ roomCode: "rd2_x", type: "chat", participants: [roommate] }];
  for (const did of [contact, roommate]) {
    const code = await ensureDmRoomForPeer(did, undefined, { unsolicited: true });
    expect(state.records.get(code!).request).toBe(false);
  }
});

it("someone we reached out to is not a request when their introduction comes back", async () => {
  const friend = identity().did;
  state.bindings.set("12D3-friend", friend);
  // Our side opens the DM by device; the reply introduction arrives through
  // the unsolicited path before our call has stored anything.
  state.transport.introduceDm.mockImplementationOnce(async () => {
    await ensureDmRoomForPeer(friend, undefined, { unsolicited: true });
    return true;
  });
  const code = await ensureDmRoomForPeer("12D3-friend");
  expect(state.records.get(code!).request).toBe(false);
});

it("drops new strangers once the requests are full, joining nothing", async () => {
  for (let i = 0; i < MAX_DM_REQUESTS; i++) {
    expect(await ensureDmRoomForPeer(identity().did, undefined, { unsolicited: true })).not.toBeNull();
  }
  state.transport.joinSecureConversation.mockClear();
  const late = identity().did;
  expect(await ensureDmRoomForPeer(late, undefined, { unsolicited: true })).toBeNull();
  expect(state.records.has(await room(late))).toBe(false);
  expect(state.transport.joinSecureConversation).not.toHaveBeenCalled();
});

it("reads what admitting a stranger takes once for a burst, not once per sender", async () => {
  for (let i = 0; i < MAX_DM_REQUESTS; i++) {
    await ensureDmRoomForPeer(identity().did, undefined, { unsolicited: true });
  }
  state.roomReads = 0;
  for (let i = 0; i < 10; i++) {
    expect(await ensureDmRoomForPeer(identity().did, undefined, { unsolicited: true })).toBeNull();
  }
  expect(state.roomReads).toBe(1);
});

it("holds the cap under a burst", async () => {
  const burst = Array.from({ length: MAX_DM_REQUESTS + 5 }, () =>
    ensureDmRoomForPeer(identity().did, undefined, { unsolicited: true })
  );
  const codes = await Promise.all(burst);
  expect(codes.filter(Boolean)).toHaveLength(MAX_DM_REQUESTS);
});

it("opening a request does not accept it; accepting or answering does", async () => {
  const stranger = identity().did, other = identity().did;
  const code = (await ensureDmRoomForPeer(stranger, undefined, { unsolicited: true }))!;
  await ensureDmRoomForPeer(stranger);
  expect(state.records.get(code).request).toBe(true);
  await acceptDmRequest(stranger);
  expect(state.records.get(code).request).toBe(false);

  state.bindings.set("12D3-other", other);
  const second = (await ensureDmRoomForPeer(other, undefined, { unsolicited: true }))!;
  expect(state.records.get(second).request).toBe(true);
  await sendDirectMessage("hi", { peerId: "12D3-other" });
  expect(state.records.get(second).request).toBe(false);
});
