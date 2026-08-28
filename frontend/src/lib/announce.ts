import { MessageType, type Message } from "./types/message";
import { notifyMessage } from "./notify.svelte";
import { humanizeMentions, mentionsMe } from "./mentions";
import { getManifest } from "./plugins/registry";
import { roomsStore } from "./rooms.svelte";

/**
 * Telling the user a message arrived: the sound, and the notification when the
 * app is out of sight.
 *
 * Its own module because room chat is delivered TWICE on purpose - a gossipsub
 * publish plus a direct one-message copy per member, so a dead or still-forming
 * mesh cannot swallow it - and BOTH delivery paths have to announce, or the
 * message is silent whenever the arm that does not announce wins the race. Two
 * callers announcing the same message need one place that decides, and one
 * place that remembers what has already been said.
 *
 * The transport knows how a message arrived. This knows how to say so.
 */

/** Everything announceMessage needs to know that only the caller can answer. */
export interface AnnounceContext {
  /** Every id that means "me": the DID and the transport peer id. */
  selfIds: string[];
  /** The conversation on screen, so a sound is not played over the reader. */
  uiRoomCode: string | null;
  /** DID -> display name, for rendering @mentions in the preview text. */
  resolveName: (did: string) => string;
}

/**
 * Ids already announced this session. Bounded, because a long-lived tab in a
 * busy room would otherwise grow it without limit.
 */
const announced = new Set<string>();
const CAP = 1000;

/** Claim an id, or report that someone already announced it. */
function claim(id: string): boolean {
  if (announced.has(id)) return false;
  announced.add(id);
  if (announced.size > CAP) {
    // Insertion-ordered, so iteration hands back the oldest ids first.
    let drop = announced.size - CAP / 2;
    for (const old of announced) {
      announced.delete(old);
      if (--drop <= 0) break;
    }
  }
  return true;
}

/** Test seam: a fresh module per case is not worth a vi.resetModules dance. */
export function _resetAnnounced(): void {
  announced.clear();
}

/**
 * Announce a message the caller has established is genuinely new.
 *
 * Claims the id first, so the second delivery of the same message is silent
 * even when both delivery paths read storage before either wrote. Never
 * throws: this runs between storing a message and painting it, and an
 * escaping error there turns "stored" into "invisible until refresh".
 */
export function announceMessage(msg: Message, ctx: AnnounceContext): void {
  if (
    msg.type === MessageType.Reaction ||
    msg.type === MessageType.PluginUpdate
  ) {
    // A heart on an old message and a plugin's state update have nothing to
    // read, so there is nothing to announce.
    return;
  }
  if (ctx.selfIds.includes(msg.senderId)) {
    // Your own message, arriving back from another device or a peer replaying
    // history. Announcing it would beep at you for what you just wrote.
    return;
  }
  if (!claim(msg.id)) return;

  try {
    let body = msg.content || "[file]";
    if (msg.type === MessageType.PluginCard) {
      try {
        const payload = JSON.parse(msg.content);
        const manifest = getManifest(payload.pluginId);
        body = `posted a ${manifest?.name || payload.pluginId}`;
      } catch {
        body = "posted a plugin card";
      }
    } else {
      body = humanizeMentions(body, ctx.resolveName);
    }

    // DM files and plugin cards ride the room broadcast path too, so this has
    // to be able to speak both shapes.
    const isDm = msg.roomCode.startsWith("dm-");
    let title: string;
    let preview: string;
    if (isDm) {
      // In a DM the sender IS the conversation; naming them twice is noise.
      title = msg.senderName;
      preview = body;
    } else if (mentionsMe(msg.content ?? "", ctx.selfIds)) {
      title = `${msg.senderName} mentioned you`;
      preview = `${msg.senderName}: ${body}`;
    } else {
      // The message's OWN room, not the one on screen: titling a background
      // room's message with the open room's name pointed the reader at the
      // wrong conversation.
      title =
        roomsStore.rooms.find((r) => r.roomCode === msg.roomCode)?.name ||
        msg.roomCode;
      preview = `${msg.senderName}: ${body}`;
    }

    notifyMessage({
      title,
      body: preview,
      tag: `${isDm ? "dm" : "room"}:${msg.roomCode}`,
      viewingConversation: ctx.uiRoomCode === msg.roomCode,
      data: {
        roomCode: msg.roomCode,
        // An inbound DM's sender IS the other side of the conversation, so a
        // click on the notification routes straight back to it.
        dmPeerDid: isDm ? msg.senderDid || msg.senderId : undefined,
      },
    });
  } catch (err) {
    console.warn("[chat] notification failed:", err);
  }
}
