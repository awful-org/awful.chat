import { afterEach, expect, it, vi } from "vitest";
vi.mock("@libp2p/webrtc", () => ({ webRTC: () => ({}) }));
import { createLibp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@libp2p/noise";
import { yamux } from "@libp2p/yamux";
import { LibP2PTransport } from "./transport";
import { ROOM_PROTOCOL } from "$lib/room-security/stream";
import { deriveRoomKeys, newRoomSecret } from "$lib/room-security/keys";
import { pairwiseRoomSecret } from "$lib/room-security/pairwise";
import { hybridPairwiseRoomSecret, type DmPqState } from "$lib/room-security/pq-dm";
import { DM_INTRODUCTION_PROTOCOL } from "$lib/room-security/dm-introduction-stream";
import { ed25519 } from "@noble/curves/ed25519.js";
import { publicKeyToDid } from "$lib/identity/identity";
import { hashDmRoomCode } from "../dm-codec";

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((stop) => stop())); });

async function peer() {
  const node = await createLibp2p({
    addresses: { listen: ["/ip4/127.0.0.1/tcp/0/ws"] },
    transports: [webSockets()], connectionEncrypters: [noise()], streamMuxers: [yamux()],
  });
  const transport = new LibP2PTransport();
  const internal = transport as any;
  internal.node = node;
  internal.rendezvousSend = () => {};
  await node.handle(ROOM_PROTOCOL, (stream, connection) => {
    internal.attachSecureStream(stream, connection);
  });
  await node.handle(DM_INTRODUCTION_PROTOCOL, (stream, connection) => {
    internal.attachIntroduction(stream, connection);
  });
  cleanup.push(async () => {
    for (const handle of internal.dmIntroductions.values()) handle.close();
    for (const room of transport.rooms()) transport.leaveRoom(room);
    await node.stop();
  });
  return { node, transport };
}

it("authenticates and exchanges fragmented profiles over real Noise/Yamux/WebSocket streams", async () => {
  const [alice, bob] = await Promise.all([peer(), peer()]);
  const secret = newRoomSecret();
  const room = alice.transport.joinSecureRoom(secret);
  bob.transport.joinSecureRoom(secret);
  await alice.node.peerStore.merge(bob.node.peerId, { multiaddrs: bob.node.getMultiaddrs() });
  const receive = vi.fn();
  bob.transport.on("message", receive);
  const data = new Uint8Array(700_000).fill(37);
  expect(await alice.transport.sendRoom(bob.node.peerId.toString(), room, data)).toBe(true);
  await vi.waitFor(() => expect(receive).toHaveBeenCalledTimes(1), { timeout: 5000 });
  expect(receive.mock.calls[0][0]).toBe(alice.node.peerId.toString());
  expect(receive.mock.calls[0][1]).toEqual(data);
  expect(receive.mock.calls[0][2]).toBe(room);
  expect(bob.transport.isRoomPeer(room, alice.node.peerId.toString())).toBe(true);
}, 15_000);

it("introduces account identities over actual device peers, then sends only in their private DM", async () => {
  const [alice, bob] = await Promise.all([peer(), peer()]);
  function identity() {
    const privateKey = crypto.getRandomValues(new Uint8Array(32));
    const publicKey = new Uint8Array(ed25519.getPublicKey(privateKey));
    return { privateKey, publicKey, did: publicKeyToDid(publicKey) };
  }
  const a = identity(), b = identity();
  const local = await hashDmRoomCode(a.did, b.did);
  const bindings = new Map<string, string>();
  alice.transport.setDmIntroduction(() => a, async (device, did, secret) => {
    bindings.set(device, did); alice.transport.joinSecureConversation(local, secret);
  });
  bob.transport.setDmIntroduction(() => b, async (device, did, secret) => {
    bindings.set(device, did); bob.transport.joinSecureConversation(local, secret);
  });
  await alice.node.peerStore.merge(bob.node.peerId, { multiaddrs: bob.node.getMultiaddrs() });
  // Production dialPeer additionally handles relay addresses; this test already
  // has a real direct connection and exercises newStream/Noise binding unchanged.
  const connection = await alice.node.dial(bob.node.getMultiaddrs());
  (alice.transport as any).dialPeer = async () => {};
  expect(connection.remotePeer.toString()).toBe(bob.node.peerId.toString());
  expect(await alice.transport.introduceDm(bob.node.peerId.toString(), b.did)).toBe(true);
  expect(bindings.get(bob.node.peerId.toString())).toBe(b.did);
  expect(bindings.get(alice.node.peerId.toString())).toBe(a.did);
  const receive = vi.fn(); bob.transport.on("message", receive);
  expect(await alice.transport.sendRoom(bob.node.peerId.toString(), local, new Uint8Array([42]))).toBe(true);
  await vi.waitFor(() => expect(receive).toHaveBeenCalledWith(alice.node.peerId.toString(), new Uint8Array([42]), local));
}, 15_000);

it("upgrades a DM to its post-quantum key during the introduction and keeps talking", async () => {
  const [alice, bob] = await Promise.all([peer(), peer()]);
  function identity() {
    const privateKey = crypto.getRandomValues(new Uint8Array(32));
    const publicKey = new Uint8Array(ed25519.getPublicKey(privateKey));
    return { privateKey, publicKey, did: publicKeyToDid(publicKey) };
  }
  const a = identity(), b = identity();
  const local = await hashDmRoomCode(a.did, b.did);
  const classicalA = pairwiseRoomSecret(a.privateKey, b.publicKey);
  const classicalB = pairwiseRoomSecret(b.privateKey, a.publicKey);
  const states: DmPqState[] = [];
  alice.transport.setDmIntroduction(() => a, async (_device, _did, secret) => {
    alice.transport.joinSecureConversation(local, secret);
  }, async (_device, _did, state) => {
    states.push(state);
    alice.transport.joinSecureConversation(local, hybridPairwiseRoomSecret(a.privateKey, b.publicKey, state), classicalA);
  });
  bob.transport.setDmIntroduction(() => b, async (_device, _did, secret) => {
    bob.transport.joinSecureConversation(local, secret);
  }, async (_device, _did, state) => {
    states.push(state);
    bob.transport.joinSecureConversation(local, hybridPairwiseRoomSecret(b.privateKey, a.publicKey, state), classicalB);
  });
  await alice.node.peerStore.merge(bob.node.peerId, { multiaddrs: bob.node.getMultiaddrs() });
  await alice.node.dial(bob.node.getMultiaddrs());
  (alice.transport as any).dialPeer = async () => {};
  expect(await alice.transport.introduceDm(bob.node.peerId.toString(), b.did)).toBe(true);
  await vi.waitFor(() => expect(states).toHaveLength(2));
  expect(states[0]).toEqual(states[1]);
  // Both left the classical room; the conversation now lives on the hybrid one.
  const classicalWire = deriveRoomKeys(classicalA).discoveryId;
  expect((alice.transport as any).secureRooms.has(classicalWire)).toBe(false);
  expect((bob.transport as any).secureRooms.has(classicalWire)).toBe(false);
  const receive = vi.fn(); bob.transport.on("message", receive);
  expect(await alice.transport.sendRoom(bob.node.peerId.toString(), local, new Uint8Array([99]))).toBe(true);
  await vi.waitFor(() => expect(receive).toHaveBeenCalledWith(alice.node.peerId.toString(), new Uint8Array([99]), local));
}, 15_000);

it("does not authorize a real connected peer without the room capability", async () => {
  const [alice, bob] = await Promise.all([peer(), peer()]);
  const room = alice.transport.joinSecureRoom(newRoomSecret());
  bob.transport.joinSecureRoom(newRoomSecret());
  await alice.node.peerStore.merge(bob.node.peerId, { multiaddrs: bob.node.getMultiaddrs() });
  expect(await alice.transport.sendRoom(bob.node.peerId.toString(), room, new Uint8Array([1]))).toBe(false);
  expect(alice.transport.isRoomPeer(room, bob.node.peerId.toString())).toBe(false);
}, 15_000);

it("uses a protected wire room while delivering local DM scopes in both directions", async () => {
  const [alice, bob] = await Promise.all([peer(), peer()]);
  const secret = newRoomSecret();
  const local = "dm-" + "a".repeat(40);
  const wire = alice.transport.joinSecureConversation(local, secret);
  expect(bob.transport.joinSecureConversation(local, secret)).toBe(wire);
  await alice.node.peerStore.merge(bob.node.peerId, { multiaddrs: bob.node.getMultiaddrs() });
  const atBob = vi.fn();
  const atAlice = vi.fn();
  bob.transport.on("message", atBob);
  alice.transport.on("message", atAlice);
  expect(await alice.transport.sendRoom(bob.node.peerId.toString(), local, new Uint8Array([7]))).toBe(true);
  await vi.waitFor(() => expect(atBob).toHaveBeenCalledWith(alice.node.peerId.toString(), new Uint8Array([7]), local));
  expect(bob.transport.isRoomPeer(local, alice.node.peerId.toString())).toBe(true);
  await bob.transport.broadcast(new Uint8Array([8]), local);
  await vi.waitFor(() => expect(atAlice).toHaveBeenCalledWith(bob.node.peerId.toString(), new Uint8Array([8]), local));
  expect(alice.transport.rooms()).toEqual([local]);
}, 15_000);
