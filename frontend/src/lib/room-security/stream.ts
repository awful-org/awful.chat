import type { Connection, Stream, StreamMessageEvent } from "@libp2p/interface";
import type { DiscoveryId, RoomKeys } from "./keys";
import { isMembershipHello, SecureRoomChannel } from "./channel";
import { FrameAssembler } from "../transport/libp2p/frame-assembler";

export const ROOM_PROTOCOL = "/awful/room/2.0.0";
const LIMIT = 2 * 1024 * 1024;
/** The first frame is the membership hello, from a peer that has proven
 *  nothing yet: anyone who learns a room's public id can dial a member. */
const HELLO_LIMIT = 2048;

/** Owns framing and lifetime on one Noise-authenticated libp2p stream. */
export function attachRoomStream(options: {
  stream: Stream;
  connection: Connection;
  local: string;
  rooms: ReadonlyMap<DiscoveryId, RoomKeys>;
  initiate?: RoomKeys;
  /** Asked when an inbound stream names a room we hold, before any reply: false refuses it. */
  admit?: (room: DiscoveryId) => boolean;
  onReady: (room: DiscoveryId, channel: SecureRoomChannel) => void;
  onData: (room: DiscoveryId, data: Uint8Array) => void;
  onClose: () => void;
}): { close: () => void; getChannel: () => SecureRoomChannel | null } {
  const { stream, connection } = options;
  let channel: SecureRoomChannel | null = null;
  // Each byte copied once, and a frame refused at its header: merging every
  // chunk into one growing buffer cost a full copy per chunk, so one 2 MB frame
  // sent in tiny pieces held the main thread for seconds.
  let frames = new FrameAssembler(() => (channel ? LIMIT : HELLO_LIMIT));
  let closed = false;
  const pendingWrites = new Set<() => void>();
  const timer = setTimeout(close, 10_000);

  function close() {
    if (closed) return;
    closed = true;
    clearTimeout(timer);
    for (const cancel of pendingWrites) cancel();
    stream.removeEventListener("message", receive);
    stream.removeEventListener("close", close);
    channel?.close();
    frames = new FrameAssembler(0);
    stream.abort(new Error("Room channel closed"));
    options.onClose();
  }

  async function write(value: unknown) {
    if (closed || connection.status !== "open") throw new Error("Room stream unavailable");
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    if (bytes.length > LIMIT) throw new Error("Oversized room frame");
    const frame = new Uint8Array(4 + bytes.length);
    new DataView(frame.buffer).setUint32(0, bytes.length);
    frame.set(bytes, 4);
    // false means accepted but backpressured; await drain rather than dropping
    // a healthy room channel during an ordinary burst of history messages.
    if (!stream.send(frame)) {
      let cancel!: () => void;
      let timeout!: ReturnType<typeof setTimeout>;
      const stopped = new Promise<never>((_, reject) => {
        cancel = () => reject(new Error("Room write stopped"));
        timeout = setTimeout(cancel, 10_000);
      });
      pendingWrites.add(cancel);
      try { await Promise.race([stream.onDrain(), stopped]); }
      finally { clearTimeout(timeout); pendingWrites.delete(cancel); }
    }
    if (closed || connection.status !== "open") throw new Error("Room stream closed during write");
  }

  function create(keys: RoomKeys, role: "initiator" | "responder") {
    channel = new SecureRoomChannel(keys, options.local, connection.remotePeer.toString(), role,
      write, (data) => options.onData(keys.discoveryId, data), close);
    const current = channel;
    void current.ready.then(() => {
      if (closed || connection.status !== "open") { close(); return; }
      clearTimeout(timer);
      options.onReady(keys.discoveryId, current);
    }).catch(close);
  }

  function receive(event: StreamMessageEvent) {
    try {
      if (closed || connection.status !== "open") { close(); return; }
      const chunk = event.data instanceof Uint8Array ? event.data : event.data.subarray();
      // One event can hold many whole frames (a relay circuit hands over as
      // much as its window lets it read at once); each has its own limit,
      // read after the frame before it, so the hello opens the larger one.
      frames.add(chunk);
      for (let bytes = frames.next(); bytes; bytes = frames.next()) {
        const length = bytes.length;
        const frame = JSON.parse(new TextDecoder().decode(bytes));
        if (!channel) {
          if (!isMembershipHello(frame)) throw new Error("Expected membership hello");
          const keys = options.rooms.get(frame.room as DiscoveryId);
          if (!keys) throw new Error("Unknown room");
          if (options.admit && !options.admit(keys.discoveryId)) throw new Error("Room stream refused");
          create(keys, "responder");
        }
        channel!.receive(frame, length);
      }
    } catch { close(); }
  }

  stream.addEventListener("message", receive);
  stream.addEventListener("close", close);
  if (options.initiate) create(options.initiate, "initiator");
  return { close, getChannel: () => channel };
}
