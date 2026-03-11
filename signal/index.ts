import type { ServerWebSocket } from "bun";

type PeerID = string;
type RoomID = string;

interface PeerMeta {
  id: PeerID;
  ws: ServerWebSocket<SocketData>;
}

interface SocketData {
  peerId: PeerID;
  roomId: RoomID;
}

// inbound message types from clients
type ClientMsg = { type: "signal"; to: PeerID; signal: unknown };
// outbound message types to clients
type ServerMsg =
  | { type: "peer-joined"; peerId: PeerID; initiator: boolean }
  | { type: "peer-left"; peerId: PeerID }
  | { type: "signal"; from: PeerID; signal: unknown }
  | { type: "error"; message: string };

const rooms = new Map<RoomID, Map<PeerID, PeerMeta>>();

function send(ws: ServerWebSocket<SocketData>, msg: ServerMsg) {
  ws.send(JSON.stringify(msg));
}

function getOrCreateRoom(roomId: RoomID): Map<PeerID, PeerMeta> {
  if (!rooms.has(roomId)) {
    rooms.set(roomId, new Map());
    console.log(`[room] created ${roomId}`);
  }
  return rooms.get(roomId)!;
}

function joinRoom(roomId: RoomID, peer: PeerMeta) {
  const room = getOrCreateRoom(roomId);

  if (room.has(peer.id)) {
    send(peer.ws, { type: "error", message: "peer id already in use" });
    peer.ws.close();
    return;
  }

  // for each peer, tell the connecting one to be the initiator, and tell the existing one about the newcomer id and that it's not the initiator
  for (const existing of room.values()) {
    // newcomer initiates → existing peer
    send(peer.ws, {
      type: "peer-joined",
      peerId: existing.id,
      initiator: true,
    });

    // existing peer receives → newcomer
    send(existing.ws, {
      type: "peer-joined",
      peerId: peer.id,
      initiator: false,
    });
  }

  room.set(peer.id, peer);
  console.log(`[room] ${peer.id} joined ${roomId} (${room.size} peers)`);
}

function leaveRoom(roomId: RoomID, peerId: PeerID) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.delete(peerId);
  console.log(`[room] ${peerId} left ${roomId} (${room.size} peers)`);

  // notify remaining peers
  for (const peer of room.values()) {
    send(peer.ws, { type: "peer-left", peerId });
  }

  // clean up empty rooms
  if (room.size === 0) {
    rooms.delete(roomId);
    console.log(`[room] deleted ${roomId} (empty)`);
  }
}

function relaySignal(
  roomId: RoomID,
  from: PeerID,
  to: PeerID,
  signal: unknown,
) {
  const room = rooms.get(roomId);
  if (!room) return;

  const target = room.get(to);
  if (!target) {
    console.warn(`[signal] target ${to} not found in room ${roomId}`);
    return;
  }

  send(target.ws, { type: "signal", from, signal });
}

const server = Bun.serve<SocketData>({
  port: 8080,

  fetch(req, server) {
    const url = new URL(req.url);

    if (url.pathname === "/ws") {
      const roomId = url.searchParams.get("room");
      const peerId = url.searchParams.get("id");

      if (!roomId || !peerId) {
        return new Response("missing room or id", { status: 400 });
      }

      const upgraded = server.upgrade(req, {
        data: { roomId, peerId } satisfies SocketData,
      });

      return upgraded
        ? undefined
        : new Response("upgrade failed", { status: 500 });
    }

    return new Response("not found", { status: 404 });
  },

  websocket: {
    open(ws) {
      const { roomId, peerId } = ws.data;
      const peer: PeerMeta = { id: peerId, ws };
      joinRoom(roomId, peer);
    },

    message(ws, raw) {
      const { roomId, peerId } = ws.data;

      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw as string);
      } catch {
        send(ws, { type: "error", message: "invalid json" });
        return;
      }

      switch (msg.type) {
        case "signal":
          relaySignal(roomId, peerId, msg.to, msg.signal);
          break;

        default:
          send(ws, {
            type: "error",
            message: `unknown type: ${(msg as any).type}`,
          });
      }
    },

    close(ws) {
      const { roomId, peerId } = ws.data;
      leaveRoom(roomId, peerId);
    },
  },
});

console.log(`signaling server running on ws://localhost:${server.port}/ws`);

