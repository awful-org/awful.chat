import type { SocketData, ClientMsg, ServerMsg } from "./types";
import { joinRoom, leaveRoom, relaySignal } from "./rooms";
import { isAllowedOrigin, preflight } from "./cors";
import { handleOgPreview } from "./og";
import { handleKlipySearch, handleKlipyTrending } from "./klipy";

function send(ws: import("bun").ServerWebSocket<SocketData>, msg: ServerMsg) {
  ws.send(JSON.stringify(msg));
}

const OG_PREFLIGHT_PATHS = new Set([
  "/klipy/search",
  "/klipy/trending",
  "/og/preview",
]);

const server = Bun.serve<SocketData>({
  port: 8080,

  fetch(req, server) {
    const url = new URL(req.url);

    if (req.method === "OPTIONS" && OG_PREFLIGHT_PATHS.has(url.pathname)) {
      if (!isAllowedOrigin(req.headers.get("origin"))) {
        return new Response(null, { status: 403 });
      }
      return preflight(req);
    }

    if (url.pathname === "/signal") {
      const upgraded = server.upgrade(req, {
        data: { peerId: "", roomCode: "" } satisfies SocketData,
      });
      return upgraded
        ? undefined
        : new Response("upgrade failed", { status: 500 });
    }

    if (url.pathname === "/klipy/search") return handleKlipySearch(req, url);
    if (url.pathname === "/klipy/trending")
      return handleKlipyTrending(req, url);
    if (url.pathname === "/og/preview") return handleOgPreview(req, url);

    return new Response("not found", { status: 404 });
  },

  websocket: {
    open(_ws) {},

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
          if (!ws.data.peerId) {
            send(ws, { type: "error", message: "send join first" });
            return;
          }
          relaySignal(ws.data.roomCode, ws.data.peerId, msg.to, msg.signal);
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

