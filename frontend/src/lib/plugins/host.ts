/**
 * The one place a HostApi is built. Cards rendered in chat and slash-command
 * handlers get the SAME object shape from the same code - the first version
 * had ChatView building a host inline and MsgRender passing a bare `{}`,
 * which crashed the first time a card called host.sendUpdate.
 */
import type { HostApi } from "./api";
import { seededRandom } from "$lib/utils";
import { identityStore } from "$lib/identity/identity.svelte";
import {
  onBeforeDisconnect,
  didToPeerId,
  isRelayed,
  measureClockSample,
  measureRtt,
  onPeerDisconnect,
  peerIdToDid,
  sendUpdateImmediately,
  transportState,
} from "$lib/transport/transport.svelte";
import {
  getAttachmentsByInfoHash,
  getMessage,
  getMessages,
  getPluginCardMessages,
} from "$lib/storage";
import {
  ROOM_CONTEXT_MAX_MESSAGES,
  buildRoomContext,
} from "./room-context";
import { requestJumpToMessage } from "$lib/ui-state.svelte";
import type { Message } from "$lib/types/message";
import { setNowPlayingFor } from "./media-session";
import { getCardState, onCardStateChange as onPluginCardStateChange } from "./state.svelte";
import { MessageType } from "$lib/types/message";
import { closeLocalCard, upsertLocalCard } from "./local-cards.svelte";
import {
  getCallAudioBlockedReason,
  getCallCaptureBlockedReason,
  getCallCaptureStreams,
  onCallCaptureChange,
  playCallAudio,
  stopCallAudio,
} from "$lib/transport/voice.svelte";
import { CALL_SOUND_MAX_DURATION_MS } from "$lib/audio/call-audio-mixer";

export function makeHostApi(pluginId: string, roomCode: string): HostApi {
  const nowPlayingToken = Symbol(pluginId);
  return {
    showLocalCard(data) {
      return upsertLocalCard(pluginId, roomCode, data).id;
    },
    closeLocalCard,
    callAudio: {
      blockedReason: getCallAudioBlockedReason,
      maxDurationMs: CALL_SOUND_MAX_DURATION_MS,
      // Owner-scoped: a plugin can layer several of its own clips (the mixer
      // caps concurrency), stop them by id or all at once - and can never
      // stop another plugin's sound. The host keeps its own unscoped stop
      // for deafen and teardown.
      play: (blob, options) =>
        playCallAudio(blob, { ...options, owner: pluginId }),
      stop: (id) =>
        stopCallAudio(id ? { id, owner: pluginId } : { owner: pluginId }),
    },
    callCapture: {
      blockedReason: getCallCaptureBlockedReason,
      streams: getCallCaptureStreams,
      onChange: onCallCaptureChange,
    },
    setNowPlaying(info) {
      setNowPlayingFor(nowPlayingToken, info);
    },
    async sendCard(payload) {
      const { sendCard } = await import("$lib/transport/transport.svelte");
      return sendCard(pluginId, payload);
    },
    async sendUpdate(cardId, payload, opts) {
      const { sendUpdate } = await import("$lib/transport/transport.svelte");
      // Bound to the host's room, not the open one: a pinned widget votes
      // in ITS card's room even while the user reads another.
      return sendUpdate(pluginId, cardId, payload, opts, roomCode);
    },
    roomCode: () => roomCode,
    async roomContext(options) {
      // Paged like the chat's own history read, newest-first, until the cap
      // or the room's start. Filtering and bounding live in room-context.ts.
      const wanted = Math.min(
        ROOM_CONTEXT_MAX_MESSAGES,
        Math.max(1, options?.limit ?? 50)
      );
      const collected: Message[] = [];
      let before: number | undefined = undefined;
      for (;;) {
        const page = { capped: false };
        const msgs: Message[] = await getMessages(roomCode, before, page);
        if (!msgs.length) break;
        collected.unshift(...msgs);
        // Overshoot a little: the filter drops rows, so a page of raw
        // messages does not guarantee a page of context.
        if (collected.length >= wanted * 2 || !page.capped) break;
        before = msgs[0].lamport;
      }
      return buildRoomContext(collected, { limit: wanted });
    },
    async resolveRoomImage(infoHash, options) {
      if (typeof infoHash !== "string" || !infoHash) return null;
      // The reference must be an IMAGE attachment of THIS room - a plugin
      // must not use this to pull arbitrary hashes from other rooms.
      const rows = await getAttachmentsByInfoHash(infoHash);
      const row = rows.find(
        (a) => a.roomCode === roomCode && a.mimeType.startsWith("image/")
      );
      if (!row) return null;
      if (row.data) return new Blob([row.data], { type: row.mimeType });

      const { requestFileDownload } = await import(
        "$lib/transport/transport.svelte"
      );
      const fromTransfer = async (): Promise<Blob | null> => {
        const url = transportState.fileTransfers.get(infoHash)?.blobURL;
        if (!url) return null;
        try {
          return await (await fetch(url)).blob();
        } catch {
          return null;
        }
      };
      const local = await fromTransfer();
      if (local) return local;
      requestFileDownload({
        infoHash,
        filename: row.filename,
        mimeType: row.mimeType,
        size: row.size,
      });
      const deadline =
        Date.now() + Math.min(30_000, Math.max(0, options?.timeoutMs ?? 15_000));
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
        const blob = await fromTransfer();
        if (blob) return blob;
        if (transportState.fileTransfers.get(infoHash)?.status === "failed")
          return null;
      }
      return null;
    },
    async confirm(options) {
      const { getManifest } = await import("./registry");
      const manifest = getManifest(pluginId);
      const { requestPluginConfirm } = await import("./confirm.svelte");
      return requestPluginConfirm(
        {
          id: pluginId,
          name: manifest?.name ?? pluginId,
          icon: manifest?.icon ?? "lucide:unplug",
        },
        options
      );
    },
    async openMessage(messageId) {
      if (typeof messageId !== "string" || !messageId) return false;
      const msg = await getMessage(messageId);
      // Bound to this host's room: a card must not navigate the user into
      // some other conversation.
      if (!msg || msg.roomCode !== roomCode) return false;
      requestJumpToMessage(roomCode, messageId);
      return true;
    },
    selfDid: () => identityStore.did || "",
    peers: () =>
      transportState.peers.map((peerId) => {
        const did = peerIdToDid(peerId);
        return {
          did,
          name: transportState.peerNames.get(did) ?? did.slice(0, 12),
        };
      }),
    onPeerDisconnect(listener) {
      return onPeerDisconnect(({ did }) =>
        listener({
          did,
          name: transportState.peerNames.get(did) ?? did.slice(0, 12),
        })
      );
    },
    onBeforeDisconnect,
    onCardStateChange(listener) {
      return onPluginCardStateChange(listener);
    },
    sendUpdateImmediately(cardId, payload) {
      // Same binding as sendUpdate: the card's room, never the open one.
      sendUpdateImmediately(pluginId, cardId, payload, roomCode);
    },
    async cards() {
      // Card rows only - getAllMessages decrypted the ENTIRE room history
      // for this, which froze the UI on every plugin join.
      const messages = await getPluginCardMessages(roomCode);
      const cards = messages.flatMap((message) => {
        if (message.type !== MessageType.PluginCard) return [];
        try {
          const payload = JSON.parse(message.content);
          return payload.pluginId === pluginId
            ? [
                {
                  id: message.id,
                  senderDid: message.senderDid || message.senderId,
                },
              ]
            : [];
        } catch {
          return [];
        }
      });
      const { getPlugin } = await import("./registry");
      const definition = await getPlugin(pluginId);
      if (!definition) return cards;
      return Promise.all(
        cards.map(async (card) => ({
          ...card,
          state: await getCardState(card.id, roomCode, definition),
        }))
      );
    },
    ping: (did, opts) => measureRtt(did, opts?.timeoutMs),
    clockSample: (did, opts) => measureClockSample(did, opts?.timeoutMs),
    // isRelayed works in peerIds; every plugin surface works in DIDs, so
    // the translation belongs here rather than in each caller.
    isRelayed: (did) => isRelayed(didToPeerId(did) ?? did),
    seededRandom,
    // ponytail: localStorage-backed plugin storage, namespaced per plugin.
    // Move to IndexedDB when a plugin actually outgrows string-sized values.
    storage: {
      async get(k: string) {
        try {
          const raw = localStorage.getItem(`awful:plugin:${pluginId}:${k}`);
          return raw === null ? undefined : JSON.parse(raw);
        } catch {
          return undefined;
        }
      },
      async set(k: string, v: unknown) {
        try {
          localStorage.setItem(
            `awful:plugin:${pluginId}:${k}`,
            JSON.stringify(v)
          );
        } catch {
          // Storage blocked: the value just does not survive a reload.
        }
      },
    },
  };
}
