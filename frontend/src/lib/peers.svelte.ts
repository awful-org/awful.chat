import SimplePeer from "simple-peer";
import type { Instance } from "simple-peer";
import WebTorrent from "webtorrent";

export interface PeerState {
  id: string;
  connected: boolean;
}

export interface ChatMessage {
  kind: "text" | "file";
  from: string;
  text: string;
  ts: number;
  fileName?: string;
  fileSize?: number;
  infoHash?: string;
}

export interface TransferState {
  infoHash: string;
  fileName: string;
  fileSize: number;
  progress: number; // 0–1
  done: boolean;
  seeding: boolean;
  blobURL?: string;
}

type ServerMsg =
  | { type: "peer-joined"; peerId: string; initiator: boolean }
  | { type: "peer-left"; peerId: string }
  | { type: "signal"; from: string; signal: unknown }
  | { type: "error"; message: string };

type WireMsg =
  | { kind: "text"; text: string }
  | { kind: "file-meta"; infoHash: string; fileName: string; fileSize: number }
  | { kind: "wt-signal"; infoHash: string; signal: unknown };

export const peers = $state<PeerState[]>([]);
export const messages = $state<ChatMessage[]>([]);
export const transfers = $state<TransferState[]>([]);
export const myId = crypto.randomUUID().slice(0, 8);

// known files in the room: infoHash → meta (for replaying to late joiners)
const knownFiles = new Map<string, { fileName: string; fileSize: number }>();

let ws: WebSocket | null = null;
const instances = new Map<string, Instance>(); // chat peers
const wtPeers = new Map<string, Instance>(); // wt peers: `${infoHash}:${peerId}`
const wtClient = new WebTorrent({
  dht: false,
  tracker: false,
  lsd: false,
  utPex: false,
} as any);

function wsReady(): boolean {
  return ws !== null && ws.readyState === WebSocket.OPEN;
}

function wsSend(msg: object) {
  if (wsReady()) ws!.send(JSON.stringify(msg));
}

function sendTo(peerId: string, msg: WireMsg) {
  const peer = instances.get(peerId);
  if (peer?.connected) peer.send(JSON.stringify(msg));
}

function broadcast(msg: WireMsg) {
  const payload = JSON.stringify(msg);
  for (const peer of instances.values()) {
    if (peer.connected) peer.send(payload);
  }
}

function wtKey(infoHash: string, peerId: string) {
  return `${infoHash}:${peerId}`;
}

function trackTransfer(torrent: any, seeding: boolean) {
  const existing = transfers.find((t) => t.infoHash === torrent.infoHash);
  if (!existing) {
    transfers.push({
      infoHash: torrent.infoHash,
      fileName: torrent.name ?? "unknown",
      fileSize: torrent.length ?? 0,
      progress: 0,
      done: false,
      seeding,
    });
  }

  const interval = setInterval(() => {
    const t = transfers.find((t) => t.infoHash === torrent.infoHash);
    if (!t) {
      clearInterval(interval);
      return;
    }
    t.progress = torrent.progress;
    t.done = torrent.done;
    if (torrent.done) clearInterval(interval);
  }, 300);

  torrent.on("done", () => {
    clearInterval(interval);
    torrent.files[0]?.getBlob((_err: any, blob: Blob) => {
      if (!blob) return;
      const t = transfers.find((t) => t.infoHash === torrent.infoHash);
      if (t) {
        t.done = true;
        t.progress = 1;
        t.blobURL = URL.createObjectURL(blob);
      }
    });
  });
}

// create a dedicated SimplePeer for a wt connection and wire it to the torrent, aparently you cant re-use
function createWTPeer(infoHash: string, peerId: string, initiator: boolean) {
  console.log("peerwt");
  const key = wtKey(infoHash, peerId);
  if (wtPeers.has(key)) return;

  const peer = new SimplePeer({
    initiator,
    trickle: true,
    channelName: `wt:${infoHash}`,
    streams: [],
    config: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    },
  });

  wtPeers.set(key, peer);

  // relay wt signals through the chat data channel
  peer.on("signal", (signal: unknown) => {
    sendTo(peerId, { kind: "wt-signal", infoHash, signal });
  });

  peer.on("connect", () => {
    const torrent = wtClient.get(infoHash);
    if (torrent) {
      torrent.addPeer(peer);
    }
  });

  peer.on("error", (err: Error) => {
    console.error(`[wt-peer] ${key} error`, err);
    wtPeers.delete(key);
  });

  peer.on("close", () => {
    wtPeers.delete(key);
  });
}

function handleWireMsg(from: string, raw: string | Uint8Array) {
  const text = typeof raw === "string" ? raw : new TextDecoder().decode(raw);
  const msg: WireMsg = JSON.parse(text);

  switch (msg.kind) {
    case "text":
      messages.push({ kind: "text", from, text: msg.text, ts: Date.now() });
      break;

    case "file-meta": {
      const { infoHash, fileName, fileSize } = msg;

      // store for late joiner replay
      knownFiles.set(infoHash, { fileName, fileSize });

      messages.push({
        kind: "file",
        from,
        text: fileName,
        ts: Date.now(),
        fileName,
        fileSize,
        infoHash,
      });

      // add torrent with no trackers -> only peers on the room
      if (!wtClient.get(infoHash)) {
        const torrent = wtClient.add(infoHash, { announce: [] });
        trackTransfer(torrent, false);
      }

      // initiate wt peer connection toward the sender
      createWTPeer(infoHash, from, true);
      break;
    }

    case "wt-signal": {
      const { infoHash, signal } = msg;
      const key = wtKey(infoHash, from);

      if (!wtPeers.has(key)) {
        // receiver side - create non-initiator wt peer
        createWTPeer(infoHash, from, false);
      }

      wtPeers.get(key)?.signal(signal as string);
      break;
    }
  }
}

export function seedFile(file: File) {
  wtClient.seed(file, { announce: [] }, (torrent: any) => {
    const { infoHash } = torrent;

    knownFiles.set(infoHash, { fileName: file.name, fileSize: file.size });
    trackTransfer(torrent, true);

    messages.push({
      kind: "file",
      from: myId,
      text: file.name,
      ts: Date.now(),
      fileName: file.name,
      fileSize: file.size,
      infoHash,
    });

    broadcast({
      kind: "file-meta",
      infoHash,
      fileName: file.name,
      fileSize: file.size,
    });

    // create wt peer connection toward each connected peer
    for (const [peerId] of instances) {
      createWTPeer(infoHash, peerId, false); // seeder is non-initiator for wt
    }
  });
}

// ── late joiner replay ────────────────────────────────────────────────────────

function replayFilesTo(peerId: string) {
  for (const [infoHash, { fileName, fileSize }] of knownFiles) {
    sendTo(peerId, { kind: "file-meta", infoHash, fileName, fileSize });
    // also open a wt connection toward the late joiner
    createWTPeer(infoHash, peerId, false);
  }
}

function createPeer(peerId: string, initiator: boolean): Instance {
  const peer = new SimplePeer({
    initiator,
    trickle: true,
    channelName: "chat",
    streams: [],
    config: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" },
      ],
    },
  });

  peer.on("signal", (signal: unknown) => {
    wsSend({ type: "signal", to: peerId, signal });
  });

  peer.on("connect", () => {
    const p = peers.find((p) => p.id === peerId);
    if (p) p.connected = true;
    // replay known files to this peer once chat channel is up
    replayFilesTo(peerId);
  });

  peer.on("data", (raw: Uint8Array) => {
    handleWireMsg(peerId, raw);
  });

  peer.on("close", () => removePeer(peerId));

  peer.on("error", (err: Error) => {
    console.error(`[peer] ${peerId} error`, err);
    removePeer(peerId);
  });

  instances.set(peerId, peer);
  peers.push({ id: peerId, connected: false });

  return peer;
}

function removePeer(peerId: string) {
  instances.get(peerId)?.destroy();
  instances.delete(peerId);
  const idx = peers.findIndex((p) => p.id === peerId);
  if (idx !== -1) peers.splice(idx, 1);
}

export function connect(roomId: string) {
  ws = new WebSocket(`ws://localhost:8080/ws?room=${roomId}&id=${myId}`);

  ws.onmessage = (e) => {
    const msg: ServerMsg = JSON.parse(e.data);

    switch (msg.type) {
      case "peer-joined":
        createPeer(msg.peerId, msg.initiator);
        break;

      case "peer-left":
        removePeer(msg.peerId);
        break;

      case "signal": {
        let peer = instances.get(msg.from);
        if (!peer) {
          if ((msg.signal as any)?.type === "answer") break;
          peer = createPeer(msg.from, false);
        }
        peer.signal(msg.signal as string);
        break;
      }

      case "error":
        console.error("[server]", msg.message);
        break;
    }
  };

  ws.onclose = () => console.log("[ws] disconnected");
}

export function send(text: string) {
  broadcast({ kind: "text", text });
  messages.push({ kind: "text", from: myId, text, ts: Date.now() });
}

export function disconnect() {
  for (const [id] of instances) removePeer(id);
  ws?.close();
  ws = null;
}
