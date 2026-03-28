import type { ServerWebSocket } from "bun";

export type PeerID = string;
export type RoomCode = string;

export interface PeerMeta {
  id: PeerID;
  ws: ServerWebSocket<SocketData>;
}

export interface SocketData {
  peerId: PeerID;
  roomCode: RoomCode;
}

export type ClientMsg =
  | { type: "join"; roomCode: RoomCode; peerId: PeerID }
  | { type: "signal"; to: PeerID; signal: unknown };

export type ServerMsg =
  | { type: "peer-joined"; peerId: PeerID; initiator: boolean }
  | { type: "peer-left"; peerId: PeerID }
  | { type: "signal"; from: PeerID; signal: unknown }
  | { type: "error"; message: string };

export interface OgPreview {
  url: string;
  title?: string;
  description?: string;
  siteName?: string;
  image?: string;
  imageWidth?: number;
  imageHeight?: number;
  video?: string;
  videoWidth?: number;
  videoHeight?: number;
  videoContentType?: string;
  mediaType: "video" | "image" | "none";
}

