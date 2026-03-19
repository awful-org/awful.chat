import type { ServerWebSocket } from "bun";

type PeerID = string;
type RoomCode = string;

interface PeerMeta {
  id: PeerID;
  ws: ServerWebSocket<SocketData>;
}

interface SocketData {
  peerId: PeerID;
  roomCode: RoomCode;
}

type ClientMsg =
  | { type: "join"; roomCode: RoomCode; peerId: PeerID }
  | { type: "signal"; to: PeerID; signal: unknown };

type ServerMsg =
  | { type: "peer-joined"; peerId: PeerID; initiator: boolean }
  | { type: "peer-left"; peerId: PeerID }
  | { type: "signal"; from: PeerID; signal: unknown }
  | { type: "error"; message: string };

const rooms = new Map<RoomCode, Map<PeerID, PeerMeta>>();

function send(ws: ServerWebSocket<SocketData>, msg: ServerMsg) {
  ws.send(JSON.stringify(msg));
}

function getOrCreateRoom(roomCode: RoomCode): Map<PeerID, PeerMeta> {
  if (!rooms.has(roomCode)) {
    rooms.set(roomCode, new Map());
    console.log(`[room] created ${roomCode}`);
  }
  return rooms.get(roomCode)!;
}

function joinRoom(roomCode: RoomCode, peer: PeerMeta) {
  const room = getOrCreateRoom(roomCode);

  if (room.has(peer.id)) {
    send(peer.ws, { type: "error", message: "peer id already in use" });
    peer.ws.close();
    return;
  }

  // newcomer initiates toward each existing peer
  // existing peers receive the newcomer and do NOT initiate
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

function leaveRoom(roomCode: RoomCode, peerId: PeerID) {
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

function relaySignal(
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

const KLIPY_API_BASE = "https://api.klipy.com/api/v1";
const KLIPY_API_KEY = process.env.KLIPY_API_KEY ?? "";
const NODE_ENV = process.env.NODE_ENV ?? "development";
const DOMAIN = (process.env.DOMAIN ?? "").trim().toLowerCase();

function isAllowedOrigin(origin: string | null): boolean {
  if (!origin) return true;
  if (NODE_ENV !== "production") return true;
  if (!DOMAIN) return false;

  try {
    const parsed = new URL(origin);
    return (
      parsed.protocol === "https:" && parsed.hostname.toLowerCase() === DOMAIN
    );
  } catch {
    return false;
  }
}

function corsHeaders(req: Request): Record<string, string> {
  const origin = req.headers.get("origin");
  const allowOrigin =
    NODE_ENV === "production" ? `https://${DOMAIN}` : (origin ?? "*");
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

function withCors(req: Request, response: Response): Response {
  const headers = new Headers(response.headers);
  const cors = corsHeaders(req);
  for (const [k, v] of Object.entries(cors)) {
    headers.set(k, v);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function preflight(req: Request): Response {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(req),
  });
}

function klipyError(req: Request, msg: string, status = 500): Response {
  return withCors(
    req,
    new Response(JSON.stringify({ error: msg }), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

async function handleKlipySearch(req: Request, url: URL): Promise<Response> {
  if (!isAllowedOrigin(req.headers.get("origin"))) {
    return klipyError(req, "Origin not allowed", 403);
  }
  if (!KLIPY_API_KEY)
    return klipyError(req, "KLIPY_API_KEY not configured", 503);

  const q = url.searchParams.get("q") ?? "";
  const limit = url.searchParams.get("limit") ?? "18";
  const page = url.searchParams.get("page") ?? "1";

  const upstream = `${KLIPY_API_BASE}/${KLIPY_API_KEY}/gifs/search?q=${encodeURIComponent(q)}&limit=${limit}&page=${page}`;

  try {
    const res = await fetch(upstream);
    if (!res.ok)
      return klipyError(req, `Klipy API error: ${res.status}`, res.status);
    const json = await res.json();
    return withCors(req, Response.json(json));
  } catch (e) {
    return klipyError(req, `Failed to fetch from Klipy: ${e}`);
  }
}

async function handleKlipyTrending(req: Request, url: URL): Promise<Response> {
  if (!isAllowedOrigin(req.headers.get("origin"))) {
    return klipyError(req, "Origin not allowed", 403);
  }
  if (!KLIPY_API_KEY)
    return klipyError(req, "KLIPY_API_KEY not configured", 503);

  const limit = url.searchParams.get("limit") ?? "18";
  const page = url.searchParams.get("page") ?? "1";

  const upstream = `${KLIPY_API_BASE}/${KLIPY_API_KEY}/gifs/trending?limit=${limit}&page=${page}`;

  try {
    const res = await fetch(upstream);
    if (!res.ok)
      return klipyError(req, `Klipy API error: ${res.status}`, res.status);
    const json = await res.json();
    return withCors(req, Response.json(json));
  } catch (e) {
    return klipyError(req, `Failed to fetch from Klipy: ${e}`);
  }
}

const server = Bun.serve<SocketData>({
  port: 8080,

  fetch(req, server) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS" && url.pathname.startsWith("/klipy/")) {
      if (!isAllowedOrigin(req.headers.get("origin"))) {
        return new Response(null, { status: 403 });
      }
      return preflight(req);
    }

    if (url.pathname === "/signal") {
      const upgraded = server.upgrade(req, {
        // roomCode and peerId are not known yet at upgrade time —
        // client sends a join message after the WS opens
        data: { peerId: "", roomCode: "" } satisfies SocketData,
      });
      return upgraded
        ? undefined
        : new Response("upgrade failed", { status: 500 });
    }

    if (url.pathname === "/klipy/search") return handleKlipySearch(req, url);
    if (url.pathname === "/klipy/trending")
      return handleKlipyTrending(req, url);

    return new Response("not found", { status: 404 });
  },

  websocket: {
    open(_ws) {
      // wait for join message — peerId and roomCode not set yet
    },

    message(ws, raw) {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(raw as string);
      } catch {
        send(ws, { type: "error", message: "invalid json" });
        return;
      }

      switch (msg.type) {
        case "join": {
          // first message after WS open — sets identity
          if (ws.data.peerId) {
            send(ws, { type: "error", message: "already joined" });
            return;
          }
          ws.data.peerId = msg.peerId;
          ws.data.roomCode = msg.roomCode;
          joinRoom(msg.roomCode, { id: msg.peerId, ws });
          break;
        }

        case "signal": {
          const { roomCode, peerId } = ws.data;
          if (!peerId) {
            send(ws, { type: "error", message: "send join first" });
            return;
          }
          relaySignal(roomCode, peerId, msg.to, msg.signal);
          break;
        }

        default: {
          send(ws, {
            type: "error",
            message: `unknown type: ${(msg as any).type}`,
          });
        }
      }
    },

    close(ws) {
      const { roomCode, peerId } = ws.data;
      if (peerId) leaveRoom(roomCode, peerId);
    },
  },
});

console.log(`signaling server running on ws://localhost:${server.port}/signal`);
