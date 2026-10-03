/**
 * The one place a HostApi is built. Cards rendered in chat and slash-command
 * handlers get the SAME object shape from the same code - the first version
 * had ChatView building a host inline and MsgRender passing a bare `{}`,
 * which crashed the first time a card called host.sendUpdate.
 */
import type { HostApi } from "./api";
import { seededRandom } from "$lib/utils";
import { identityStore } from "$lib/identity/identity.svelte";
import { profileStore } from "$lib/profile.svelte";
import { setSelfActivity } from "./activity.svelte";
import { captureSessionGuard } from "$lib/identity/session-guard";
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
import { requestElementPip, setNowPlayingFor } from "./media-session";
import {
  cardStates,
  getCardState,
  onCardStateChange as onPluginCardStateChange,
  rowRoute,
} from "./state.svelte";
import { MessageType } from "$lib/types/message";
import { closeLocalCard, upsertLocalCard } from "./local-cards.svelte";
import { showPluginError } from "./plugin-errors.svelte";
import {
  getCallAudioBlockedReason,
  getCallCaptureBlockedReason,
  getCallCaptureStreams,
  onCallCaptureChange,
  playCallAudio,
  stopCallAudio,
} from "$lib/transport/voice.svelte";
import { CALL_SOUND_MAX_DURATION_MS } from "$lib/audio/call-audio-mixer";
import { safeBlobType } from "$lib/safe-mime";
import { createPluginSendCaps } from "./flood-cap";

/**
 * Receivers drop a person's cards and persisted updates past a per-room cap
 * (flood-cap.ts), without a word, and a dropped row seldom comes back. So
 * the same caps hold here, for every plugin and host in a room together,
 * and what receivers would drop is refused before it is sent. With the
 * sending window's slack (SEND_SLACK_MS), only arrivals bunched up by more
 * than that - or a second device sending as the same person - can still
 * meet a full window on the far side.
 */
const sendCaps = createPluginSendCaps();

/** A slot under the cap, to give back if the send fails; or why not. */
function takeSendSlot(kind: "card" | "update", roomCode: string): () => void {
  const slot = sendCaps[kind](roomCode, identityStore.did || "");
  if (!slot.ok) {
    const seconds = Math.max(1, Math.ceil(slot.waitMs / 1000));
    throw new Error(
      `Too many ${kind}s at once. Try again in ${seconds} second${seconds === 1 ? "" : "s"}.`
    );
  }
  return slot.release;
}

export function makeHostApi(pluginId: string, roomCode: string): HostApi {
  const nowPlayingToken = Symbol(pluginId);
  return {
    showLocalCard(data) {
      return upsertLocalCard(pluginId, roomCode, data).id;
    },
    closeLocalCard,
    showError: (message) => showPluginError(pluginId, roomCode, message),
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
    pictureInPicture: (video) => requestElementPip(video),
    async sendCard(payload) {
      const release = takeSendSlot("card", roomCode);
      try {
        const { sendCard } = await import("$lib/transport/transport.svelte");
        return await sendCard(pluginId, payload, roomCode);
      } catch (err) {
        // A send that throws was, all but always, refused before it went
        // out (a bad payload, a room left): its slot is free again.
        release();
        throw err;
      }
    },
    async sendUpdate(cardId, payload, opts) {
      // Ephemerals keep their own cap, in the transport.
      const release = opts?.ephemeral ? () => {} : takeSendSlot("update", roomCode);
      try {
        const { sendUpdate } = await import("$lib/transport/transport.svelte");
        // Bound to the host's room, not the open one: a pinned widget votes
        // in ITS card's room even while the user reads another.
        return await sendUpdate(pluginId, cardId, payload, opts, roomCode);
      } catch (err) {
        release();
        throw err;
      }
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
      let before: Pick<Message, "lamport" | "id"> | undefined = undefined;
      for (;;) {
        const page = { capped: false };
        const msgs: Message[] = await getMessages(roomCode, before, page);
        if (!msgs.length) break;
        collected.unshift(...msgs);
        // Overshoot a little: the filter drops rows, so a page of raw
        // messages does not guarantee a page of context.
        if (collected.length >= wanted * 2 || !page.capped) break;
        before = msgs[0];
      }
      return buildRoomContext(collected, { limit: wanted });
    },
    async resolveRoomImage(infoHash, options) {
      if (typeof infoHash !== "string" || !infoHash) return null;
      const guard = captureSessionGuard();
      // The reference must be an IMAGE attachment of THIS room - a plugin
      // must not use this to pull arbitrary hashes from other rooms.
      const rows = await getAttachmentsByInfoHash(infoHash);
      guard();
      const row = rows.find(
        (a) => a.roomCode === roomCode && a.mimeType.startsWith("image/")
      );
      if (!row) return null;
      if (row.data && !row.encryption) return new Blob([row.data], { type: safeBlobType(row.mimeType) });

      const { requestFileDownload, restoreFileAttachment } = await import(
        "$lib/transport/transport.svelte"
      );
      guard();
      const fromTransfer = async (): Promise<Blob | null> => {
        guard();
        const url = transportState.fileTransfers.get(infoHash)?.blobURL;
        if (!url) return null;
        try {
          const blob = await (await fetch(url)).blob();
          guard();
          return blob;
        } catch {
          return null;
        }
      };
      const local = await fromTransfer();
      if (local) return local;
      if (row.encryption) {
        await restoreFileAttachment(row);
        guard();
        const restored = await fromTransfer();
        if (restored) return restored;
      }
      guard();
      requestFileDownload({
        infoHash,
        filename: row.filename,
        mimeType: row.mimeType,
        size: row.size,
        encryption: row.encryption,
        width: row.width,
        height: row.height,
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
      // fromDid is resolved HERE, against peers the transport actually
      // knows, and only a resolved name is passed on. A plugin naming an
      // unknown (or invented) DID gets no attribution line rather than an
      // unverified one - the whole point of the host drawing it.
      const { fromDid, ...rest } = options;
      const fromPeerName =
        typeof fromDid === "string" && fromDid
          ? transportState.peerNames.get(fromDid)
          : undefined;
      return requestPluginConfirm(
        {
          id: pluginId,
          name: manifest?.name ?? pluginId,
          icon: manifest?.icon ?? "lucide:unplug",
        },
        { ...rest, ...(fromPeerName ? { fromPeerName } : {}) }
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
    // The name this user's own updates carry (sendUpdate signs the main
    // profile's nickname), so a plugin can list itself the way peers see it.
    selfName: () => profileStore.nickname?.trim() || "Anonymous",
    setActivity: (label) => setSelfActivity(pluginId, label),
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
      // Past the cap, receivers would drop it while this client kept its own
      // copy, and the two would disagree for good. At teardown there is no
      // one to tell, so it is not sent.
      if (!sendCaps.update(roomCode, identityStore.did || "").ok) return;
      // Same binding as sendUpdate: the card's room, never the open one.
      sendUpdateImmediately(pluginId, cardId, payload, roomCode);
    },
    async cards() {
      // Card rows only - getAllMessages decrypted the ENTIRE room history
      // for this, which froze the UI on every plugin join.
      const messages = await getPluginCardMessages(roomCode);
      const cards = messages.flatMap((message) =>
        message.type === MessageType.PluginCard &&
        rowRoute(message)?.pluginId === pluginId
          ? [{ id: message.id, senderDid: message.senderDid || message.senderId }]
          : []
      );
      // `state` is what the host already holds, plus this user's own cards -
      // the ones a plugin acts on (a new /app ends its sender's earlier
      // apps). Folding EVERY card on every call is what let one member's
      // pile of cards stall the room: each fold installed a state, each
      // install woke every card, and every card asked again.
      const self = identityStore.did || "";
      const { getPlugin } = await import("./registry");
      const definition = await getPlugin(pluginId);
      return Promise.all(
        cards.map(async (card) => {
          const held = cardStates.get(card.id);
          if (held && held.roomCode === roomCode) return { ...card, state: held.state };
          if (!definition || !self || card.senderDid !== self) return card;
          return { ...card, state: await getCardState(card.id, roomCode, definition) };
        })
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
