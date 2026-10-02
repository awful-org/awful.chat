import { afterEach, expect, it, vi } from "vitest";
vi.mock("@libp2p/webrtc", () => ({ webRTC: () => ({}) }));
import { createLibp2p } from "libp2p";
import { webSockets } from "@libp2p/websockets";
import { noise } from "@libp2p/noise";
import { yamux } from "@libp2p/yamux";
import type { Connection } from "@libp2p/interface";
import { LibP2PTransport } from "./transport";
import { newRoomSecret } from "$lib/room-security/keys";

// The room-stream dedup (admitRoomStream) when the two ends of a pair open
// their streams over DIFFERENT connections - the glare the transport calls
// routine ("both sides dial each other from the same rendezvous reply"),
// where libp2p's findExistingConnection hands each side its own. Nothing
// orders two connections, so the larger peer's hello can land after the
// smaller peer's own stream has proven itself - by when the larger peer has
// closed its stream in favour of the smaller peer's. Closing the proven one
// for it left both ends with no channel, and a frame sent on it in between
// was reported sent and never arrived: every run at 25 ms, now and then at
// 10 ms (once 7 of 40 rooms with no channel and 7 frames lost). The skew-0
// and no-delay cases are controls.

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
  internal.dialPeer = async () => {};
  await internal.handleRoomStreams(node);
  cleanup.push(async () => {
    for (const room of transport.rooms()) transport.leaveRoom(room);
    await node.stop();
  });
  return { node, transport, internal };
}

function verifiedChannels(transport: LibP2PTransport, room: string): number {
  let n = 0;
  for (const entry of (transport as any).secureStreams) if (entry.room === room && entry.channel?.verified) n++;
  return n;
}

/** The stream as attachRoomStream sees it, with its `kinds` of event arriving `ms` late, in order. */
function late(stream: any, ms: number, kinds = ["message", "close"]) {
  const target = new EventTarget();
  const forward = (event: Event) => {
    const copy = Object.assign(new Event(event.type), { data: (event as any).data });
    if (kinds.includes(event.type)) setTimeout(() => target.dispatchEvent(copy), ms);
    else target.dispatchEvent(copy);
  };
  stream.addEventListener("message", forward);
  stream.addEventListener("close", forward);
  return {
    get status() { return stream.status; },
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    send: (frame: Uint8Array) => stream.send(frame),
    onDrain: (options?: unknown) => stream.onDrain(options),
    abort: (err: Error) => stream.abort(err),
  };
}

async function twoConnections() {
  const [p1, p2] = await Promise.all([peer(), peer()]);
  const [small, large] = p1.node.peerId.toString() < p2.node.peerId.toString() ? [p1, p2] : [p2, p1];
  const smallId = small.node.peerId.toString(), largeId = large.node.peerId.toString();
  // Glare: each side dialled the other.
  const c1 = await small.node.dial(large.node.getMultiaddrs());
  const c2 = await large.node.dial(small.node.getMultiaddrs(), { force: true });
  await vi.waitFor(() => {
    expect(small.node.getConnections(large.node.peerId)).toHaveLength(2);
    expect(large.node.getConnections(small.node.peerId)).toHaveLength(2);
  });
  const c2AtSmall = small.node.getConnections(large.node.peerId).find((c) => c !== c1) as Connection;
  // Each side's own dial is the connection it opens room streams on.
  small.node.dial = (async () => c1) as any;
  large.node.dial = (async () => c2) as any;
  small.internal.connectedPeers.add(largeId);
  large.internal.connectedPeers.add(smallId);
  return { small, large, smallId, largeId, c1, c2, c2AtSmall };
}

it("keeps one working channel when both ends open a room at once over different connections", async () => {
  const { small, large, smallId, largeId, c2AtSmall } = await twoConnections();
  // The larger peer's connection is the slower one by a few ms.
  const attach = small.internal.attachSecureStream.bind(small.internal);
  small.internal.attachSecureStream = (stream: any, connection: Connection, initiate?: unknown) =>
    attach(!initiate && connection === c2AtSmall ? late(stream, 25) : stream, connection, initiate);

  const secret = newRoomSecret();
  const room = small.transport.joinSecureRoom(secret);
  large.transport.joinSecureRoom(secret);
  // Discovery from both ends at once.
  small.internal.verifyDiscoveredRoomPeer(room, largeId);
  large.internal.verifyDiscoveredRoomPeer(room, smallId);

  await new Promise((resolve) => setTimeout(resolve, 1_000));
  // Both still count each other in...
  expect(small.transport.isRoomPeer(room, largeId)).toBe(true);
  expect(large.transport.isRoomPeer(room, smallId)).toBe(true);
  // ...and the spec says the stream the smaller peer started is kept.
  expect({ small: verifiedChannels(small.transport, room), large: verifiedChannels(large.transport, room) })
    .toEqual({ small: 1, large: 1 });
}, 20_000);

for (const skew of [0, 25]) {
  it(`a frame the larger peer sends on its freshly proven channel reaches the smaller one (skew ${skew} ms)`, async () => {
    const { small, large, smallId, largeId, c2AtSmall } = await twoConnections();
    if (skew) {
      const attach = small.internal.attachSecureStream.bind(small.internal);
      small.internal.attachSecureStream = (stream: any, connection: Connection, initiate?: unknown) =>
        attach(!initiate && connection === c2AtSmall ? late(stream, skew) : stream, connection, initiate);
    }
    const secret = newRoomSecret();
    const room = small.transport.joinSecureRoom(secret);
    large.transport.joinSecureRoom(secret);
    const atSmall = vi.fn();
    small.transport.on("message", atSmall);
    // What the app does on roomPeers news at the larger end: catch the new member up.
    let sent: Promise<boolean> | null = null;
    large.transport.on("roomPeers", (r: string, peers: string[]) => {
      if (r === room && peers.includes(smallId) && !sent) {
        sent = new Promise((resolve) => setTimeout(() => {
          resolve(large.transport.sendRoom(smallId, room, new Uint8Array([42])));
        }, 15));
      }
    });
    small.internal.verifyDiscoveredRoomPeer(room, largeId);
    large.internal.verifyDiscoveredRoomPeer(room, smallId);
    await new Promise((resolve) => setTimeout(resolve, 1_500));
    expect(sent).not.toBeNull();
    const result = await sent!;
    console.log(`skew ${skew}: sendRoom returned ${result}; delivered ${atSmall.mock.calls.length}; channels small=${
      verifiedChannels(small.transport, room)} large=${verifiedChannels(large.transport, room)}`);
    expect(atSmall).toHaveBeenCalledWith(largeId, new Uint8Array([42]), room);
  }, 20_000);
}

it("40 rooms discovered from both ends at once, each end on its own connection, no artificial delay", async () => {
  const { small, large, smallId, largeId } = await twoConnections();
  const secrets = Array.from({ length: 40 }, () => newRoomSecret());
  const rooms = secrets.map((secret) => small.transport.joinSecureRoom(secret));
  for (const secret of secrets) large.transport.joinSecureRoom(secret);
  // What the app does on news: catch the member up, right away.
  const sent: Array<{ room: string; ok: Promise<boolean> }> = [];
  large.transport.on("roomPeers", (room: string, peers: string[]) => {
    if (peers.includes(smallId)) sent.push({ room, ok: large.transport.sendRoom(smallId, room, new Uint8Array([7])) });
  });
  const atSmall = vi.fn();
  small.transport.on("message", atSmall);
  for (const room of rooms) {
    small.internal.verifyDiscoveredRoomPeer(room, largeId);
    large.internal.verifyDiscoveredRoomPeer(room, smallId);
  }
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  const none = rooms.filter((room) => verifiedChannels(small.transport, room) === 0 && verifiedChannels(large.transport, room) === 0);
  const okCount = (await Promise.all(sent.map((s) => s.ok))).filter(Boolean).length;
  const deliveredRooms = new Set(atSmall.mock.calls.map((call) => call[2]));
  const lost = sent.filter((s) => !deliveredRooms.has(s.room)).length;
  console.log(`two connections, 40 rooms: rooms with no channel at either end ${none.length}; catch-up sends true ${okCount}/${sent.length}; lost ${lost}`);
  expect(none).toHaveLength(0);
  expect(lost).toBe(0);
}, 30_000);

for (const skew of [3, 10]) {
  it(`40 rooms at once, the larger peer's connection ${skew} ms slower`, async () => {
    const { small, large, smallId, largeId, c2AtSmall } = await twoConnections();
    const attach = small.internal.attachSecureStream.bind(small.internal);
    small.internal.attachSecureStream = (stream: any, connection: Connection, initiate?: unknown) =>
      attach(!initiate && connection === c2AtSmall ? late(stream, skew) : stream, connection, initiate);
    const secrets = Array.from({ length: 40 }, () => newRoomSecret());
    const rooms = secrets.map((secret) => small.transport.joinSecureRoom(secret));
    for (const secret of secrets) large.transport.joinSecureRoom(secret);
    const sent: Array<{ room: string; ok: Promise<boolean> }> = [];
    large.transport.on("roomPeers", (room: string, peers: string[]) => {
      if (peers.includes(smallId)) sent.push({ room, ok: large.transport.sendRoom(smallId, room, new Uint8Array([7])) });
    });
    const atSmall = vi.fn();
    small.transport.on("message", atSmall);
    for (const room of rooms) {
      small.internal.verifyDiscoveredRoomPeer(room, largeId);
      large.internal.verifyDiscoveredRoomPeer(room, smallId);
    }
    await new Promise((resolve) => setTimeout(resolve, 3_000));
    const none = rooms.filter((room) => verifiedChannels(small.transport, room) === 0 && verifiedChannels(large.transport, room) === 0);
    const okCount = (await Promise.all(sent.map((s) => s.ok))).filter(Boolean).length;
    const deliveredRooms = new Set(atSmall.mock.calls.map((call) => call[2]));
    const lost = sent.filter((s) => !deliveredRooms.has(s.room)).length;
    console.log(`skew ${skew} ms, 40 rooms: no channel at either end ${none.length}; catch-up sendRoom true ${okCount}/${sent.length}; never arrived ${lost}`);
    expect(none).toHaveLength(0);
    expect(lost).toBe(0);
  }, 30_000);
}

it("lets the larger peer replace a channel it lost moments after it proved, and its frame arrives", async () => {
  const { small, large, smallId, largeId } = await twoConnections();
  // The smaller end hears that its stream ended only late - its reset still on
  // the way - so ours is live here, and young, when their new hello lands.
  const attach = small.internal.attachSecureStream.bind(small.internal);
  small.internal.attachSecureStream = (stream: any, connection: Connection, initiate?: unknown) =>
    attach(initiate ? late(stream, 3_000, ["close"]) : stream, connection, initiate);
  const secret = newRoomSecret();
  const room = small.transport.joinSecureRoom(secret);
  large.transport.joinSecureRoom(secret);
  small.internal.verifyDiscoveredRoomPeer(room, largeId);
  await vi.waitFor(() => {
    expect(small.transport.isRoomPeer(room, largeId)).toBe(true);
    expect(large.transport.isRoomPeer(room, smallId)).toBe(true);
  });
  // The larger end loses its end of it - reloaded, or closed it - at once.
  for (const entry of [...large.internal.secureStreams]) entry.close();
  const atSmall = vi.fn();
  small.transport.on("message", atSmall);
  // Its fresh stream is no crossing: let in, it proves, and it takes over.
  expect(await large.transport.sendRoom(smallId, room, new Uint8Array([9]))).toBe(true);
  await vi.waitFor(() => expect(atSmall).toHaveBeenCalledWith(largeId, new Uint8Array([9]), room));
  expect({ small: verifiedChannels(small.transport, room), large: verifiedChannels(large.transport, room) })
    .toEqual({ small: 1, large: 1 });
}, 20_000);
