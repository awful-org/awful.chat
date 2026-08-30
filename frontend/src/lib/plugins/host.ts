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
  measureRtt,
  onPeerDisconnect,
  peerIdToDid,
  sendUpdateImmediately,
  transportState,
} from "$lib/transport/transport.svelte";
import { getPluginCardMessages } from "$lib/storage";
import { setNowPlayingFor } from "./media-session";
import { getCardState, onCardStateChange as onPluginCardStateChange } from "./state.svelte";
import { MessageType } from "$lib/types/message";
import { closeLocalCard, upsertLocalCard } from "./local-cards.svelte";
import {
  getCallAudioBlockedReason,
  playCallAudio,
  stopCallAudio,
} from "$lib/transport/voice.svelte";

export function makeHostApi(pluginId: string, roomCode: string): HostApi {
  const nowPlayingToken = Symbol(pluginId);
  return {
    showLocalCard(data) {
      return upsertLocalCard(pluginId, roomCode, data).id;
    },
    closeLocalCard,
    callAudio: {
      blockedReason: getCallAudioBlockedReason,
      play: playCallAudio,
      stop: stopCallAudio,
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
