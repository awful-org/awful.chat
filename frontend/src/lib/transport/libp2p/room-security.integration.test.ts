import { afterEach, expect, it, vi } from "vitest";
vi.mock("@libp2p/webrtc", () => ({ webRTC: () => ({}) }));
import { createLibp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@libp2p/noise";
import { yamux } from "@libp2p/yamux";
import { LibP2PTransport } from "./transport";
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
  await internal.handleRoomStreams(node);
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

/** Proven channels one side holds, per room. */
function channelsPerRoom(transport: LibP2PTransport): Map<string, number> {
  const counts = new Map<string, number>();
  for (const entry of (transport as any).secureStreams) {
    if (entry.channel?.verified) counts.set(entry.room, (counts.get(entry.room) ?? 0) + 1);
  }
  return counts;
}

/** Two devices with one real connection between them, sharing `count` rooms. */
async function sharedRooms(count: number) {
  const [alice, bob] = await Promise.all([peer(), peer()]);
  const secrets = Array.from({ length: count }, () => newRoomSecret());
  const rooms = secrets.map((secret) => alice.transport.joinSecureRoom(secret));
  for (const secret of secrets) bob.transport.joinSecureRoom(secret);
  await alice.node.peerStore.merge(bob.node.peerId, { multiaddrs: bob.node.getMultiaddrs() });
  await alice.node.dial(bob.node.getMultiaddrs());
  // Both ends hold the connection before rooms are opened over it, as they
  // do in production, where each side dials (dialPeer) before opening any.
  await vi.waitFor(() => expect(bob.node.getConnections(alice.node.peerId)).toHaveLength(1));
  const a = alice.node.peerId.toString(), b = bob.node.peerId.toString();
  for (const [side, other] of [[alice, b], [bob, a]] as const) {
    const internal = side.transport as any;
    // Production dials through the relay first; these two are already connected.
    internal.dialPeer = async () => {};
    // identify does this on a real node; the harness starts no listener for it.
    internal.connectedPeers.add(other);
  }
  // Every room from both ends at once, the way a rendezvous reply on one side
  // and PEER_JOINED on the other set them off.
  const discover = () => {
    for (const room of rooms) {
      (alice.transport as any).verifyDiscoveredRoomPeer(room, b);
      (bob.transport as any).verifyDiscoveredRoomPeer(room, a);
    }
  };
  return { alice, bob, rooms, a, b, discover };
}

/**
 * One frame per room each way, every one sent and arrived in its room - all
 * at once, or `oneAtATime`, each arriving before the next goes.
 */
async function deliversEverywhere({ alice, bob, rooms, a, b }: Awaited<ReturnType<typeof sharedRooms>>, oneAtATime = false) {
  const atBob = vi.fn(), atAlice = vi.fn();
  bob.transport.on("message", atBob);
  alice.transport.on("message", atAlice);
  const sends = rooms.flatMap((room, i) => [
    () => alice.transport.sendRoom(b, room, new Uint8Array([i])),
    () => bob.transport.sendRoom(a, room, new Uint8Array([100 + i])),
  ]);
  if (oneAtATime) {
    for (const [n, send] of sends.entries()) {
      expect(await send()).toBe(true);
      await vi.waitFor(() => expect(atBob.mock.calls.length + atAlice.mock.calls.length).toBe(n + 1));
    }
  } else {
    expect((await Promise.all(sends.map((send) => send()))).every(Boolean)).toBe(true);
  }
  await vi.waitFor(() => {
    expect(atBob).toHaveBeenCalledTimes(rooms.length);
    expect(atAlice).toHaveBeenCalledTimes(rooms.length);
  }, { timeout: 20_000 });
  rooms.forEach((room, i) => {
    expect(atBob).toHaveBeenCalledWith(a, new Uint8Array([i]), room);
    expect(atAlice).toHaveBeenCalledWith(b, new Uint8Array([100 + i]), room);
  });
}

it("gives two devices sharing 40 rooms one channel per room, all delivering both ways", async () => {
  const pair = await sharedRooms(40);
  pair.discover();
  // Past libp2p's old 32 streams per protocol and our old 32 per connection,
  // with no room left out and no pair holding two.
  await vi.waitFor(() => {
    for (const side of [pair.alice, pair.bob]) {
      const counts = channelsPerRoom(side.transport);
      expect(pair.rooms.filter((room) => counts.get(room) === 1)).toHaveLength(40);
      expect(counts.size).toBe(40);
    }
  }, { timeout: 30_000 });
  for (const room of pair.rooms) {
    expect(pair.alice.transport.isRoomPeer(room, pair.b)).toBe(true);
    expect(pair.bob.transport.isRoomPeer(room, pair.a)).toBe(true);
  }
  await deliversEverywhere(pair);
}, 60_000);

it("closes the least recently used idle channels past the limit, and reopens them on the next send", async () => {
  const pair = await sharedRooms(6);
  const { alice, bob, rooms, a, b } = pair;
  const roster = vi.fn();
  alice.transport.on("roomPeers", roster);
  pair.discover();
  await vi.waitFor(() => {
    expect(roster).toHaveBeenCalledTimes(6);
    for (const room of rooms) expect(bob.transport.isRoomPeer(room, a)).toBe(true);
  }, { timeout: 20_000 });
  // Three at most, and no quiet period first, so the next pass - the
  // reconcile tick's - closes three at once. Set only now: the quiet period
  // is also what lets the other end finish a handshake before its channel
  // can close, and at zero a channel could go before Bob had proven it.
  (alice.transport as any).roomChannelLimits = { total: 3, perConnection: 3, idleMs: 0 };
  const held = () => [...channelsPerRoom(alice.transport).values()].reduce((sum, n) => sum + n, 0);
  (alice.transport as any).trimRoomChannels();
  expect(held()).toBe(3);
  expect((alice.transport as any).debugStats.roomChannelsClosedIdle).toBe(3);
  // Closed is not gone: both ends still count the other in, in every room.
  for (const room of rooms) {
    expect(alice.transport.isRoomPeer(room, b)).toBe(true);
    expect(bob.transport.isRoomPeer(room, a)).toBe(true);
  }
  // A send from either end opens what the other closed. One at a time: with
  // no quiet period a channel can close under a frame the other end is
  // sending that instant, the race ROOM_CHANNEL_QUIET_MS makes rare.
  await deliversEverywhere(pair, true);
  // ...without announcing anybody again: a reopened channel is not news.
  expect(roster).toHaveBeenCalledTimes(6);
  await vi.waitFor(() => expect(held()).toBeLessThanOrEqual(3));
}, 60_000);

it("keeps channels used lately open past the limit, and closes the quiet ones first", async () => {
  const pair = await sharedRooms(4);
  const { alice, rooms } = pair;
  (alice.transport as any).roomChannelLimits = { total: 2, perConnection: 2, idleMs: 60_000 };
  pair.discover();
  await vi.waitFor(() => expect(channelsPerRoom(alice.transport).size).toBe(4), { timeout: 20_000 });
  // All four carried their handshake moments ago: the limit bends.
  expect((alice.transport as any).trimRoomChannels()).toBe(true);
  expect(channelsPerRoom(alice.transport).size).toBe(4);
  for (const entry of (alice.transport as any).secureStreams) {
    if (entry.room === rooms[0]) entry.usedAt -= 180_000;
    if (entry.room === rooms[1]) entry.usedAt -= 120_000;
  }
  expect((alice.transport as any).trimRoomChannels()).toBe(false);
  expect([...channelsPerRoom(alice.transport).keys()].sort()).toEqual([rooms[2], rooms[3]].sort());
}, 30_000);

it("stops counting a member once a fresh channel to them is refused", async () => {
  const pair = await sharedRooms(2);
  const { alice, bob, rooms, b } = pair;
  pair.discover();
  await vi.waitFor(() => expect(channelsPerRoom(alice.transport).size).toBe(2), { timeout: 20_000 });
  // Bob leaves the first room, and the relay's word of it never reaches Alice.
  bob.transport.leaveRoom(rooms[0]);
  await vi.waitFor(() => expect(channelsPerRoom(alice.transport).has(rooms[0])).toBe(false));
  // A closed channel alone is not a departure...
  expect(alice.transport.isRoomPeer(rooms[0], b)).toBe(true);
  // ...but a refused one is.
  expect(await alice.transport.sendRoom(b, rooms[0], new Uint8Array([1]))).toBe(false);
  expect(alice.transport.isRoomPeer(rooms[0], b)).toBe(false);
  expect(alice.transport.isRoomPeer(rooms[1], b)).toBe(true);
  expect((alice.transport as any).debugStats.roomChannelRefusals).toBeGreaterThan(0);
}, 30_000);

it("takes the relay's word that a member left, and announces them again when they return", async () => {
  const pair = await sharedRooms(1);
  const { alice, rooms: [room], a, b } = pair;
  const internal = alice.transport as any;
  pair.discover();
  await vi.waitFor(() => expect(channelsPerRoom(alice.transport).get(room)).toBe(1), { timeout: 20_000 });
  for (const entry of [...internal.secureStreams]) entry.close();
  expect(alice.transport.isRoomPeer(room, b)).toBe(true);
  internal.handleRendezvousMsg(a, { type: "PEER_LEFT", room, peer: b });
  expect(alice.transport.isRoomPeer(room, b)).toBe(false);
  expect(alice.transport.peersInRoom(room)).toEqual([]);
  const roster = vi.fn();
  alice.transport.on("roomPeers", roster);
  expect(await alice.transport.sendRoom(b, room, new Uint8Array([1]))).toBe(true);
  expect(roster).toHaveBeenCalledWith(room, [b]);
}, 30_000);
