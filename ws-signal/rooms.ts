import type { PeerID, RoomCode, PeerMeta, ServerMsg } from "./types";
import type { ServerWebSocket } from "bun";

const rooms = new Map<RoomCode, Map<PeerID, PeerMeta>>();

function send(
  ws: ServerWebSocket<{ peerId: PeerID; roomCode: RoomCode }>,
  msg: ServerMsg,
) {
  ws.send(JSON.stringify(msg));
}

export function getOrCreateRoom(roomCode: RoomCode): Map<PeerID, PeerMeta> {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, new Map());
    console.log(`[room] created ${roomCode}`);
  }
  return rooms.get(roomCode)!;
}

export function joinRoom(roomCode: RoomCode, peer: PeerMeta) {
  const room = getOrCreateRoom(roomCode);

  if (room.has(peer.id)) {
    send(peer.ws, { type: "error", message: "peer id already in use" });
    peer.ws.close();
    return;
  }

  for (const existing of room.values()) {
    send(peer.ws, {
      type: "peer-joined",
      peerId: existing.id,
      initiator: true,
    });
    send(existing.ws, {
      type: "peer-joined",
      peerId: peer.id,
      initiator: false,
    });
  }

  room.set(peer.id, peer);
  console.log(`[room] ${peer.id} joined ${roomCode} (${room.size} peers)`);
}

export function leaveRoom(roomCode: RoomCode, peerId: PeerID) {
  const room = rooms.get(roomCode);
  if (!room) return;

  room.delete(peerId);
  console.log(`[room] ${peerId} left ${roomCode} (${room.size} peers)`);

  for (const peer of room.values()) {
    send(peer.ws, { type: "peer-left", peerId });
  }

  if (room.size === 0) {
    rooms.delete(roomCode);
    console.log(`[room] deleted ${roomCode} (empty)`);
  }
}

export function relaySignal(
  roomCode: RoomCode,
  from: PeerID,
  to: PeerID,
  signal: unknown,
) {
  const room = rooms.get(roomCode);
  if (!room) return;

  const target = room.get(to);
  if (!target) {
    console.warn(`[signal] target ${to} not found in room ${roomCode}`);
    return;
  }

  send(target.ws, { type: "signal", from, signal });
}

