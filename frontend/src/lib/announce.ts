import { MessageType, type Message } from "./types/message";
import { closeNotificationsByTag, notifyMessage } from "./notify.svelte";
import { humanizeMentions, mentionsMe } from "./mentions";
import { getManifest } from "./plugins/registry";
import { getRoomNotifyMode } from "./notify-prefs.svelte";
import { roomsStore } from "./rooms.svelte";
import { hashRef } from "./storage-crypto";
import { ROOM_REF_PREFIX, rememberRoomRef } from "./notify-intents";

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

/**
 * A burst is ONE notification.
 *
 * An offline mailbox hands over everything that arrived while the app was
 * closed in a single collect, and a room that has been quiet for an hour
 * delivers its backlog the moment the mesh forms. Announced one at a time
 * that is a dozen buzzes and a dozen beeps for what the user will read as one
 * batch. So the first message goes out immediately - a live conversation must
 * not feel laggy - and anything landing within the window behind it is
 * collapsed into a single "N new messages" when the window closes.
 *
 * The window does NOT extend on each new message: a busy room would keep
 * pushing the flush out and the notification would never arrive.
 */
const BURST_MS = 2000;

/** A notification that has been decided on but not yet shown. */
interface Pending {
  roomCode: string;
  ref: string;
  tag: string;
  title: string;
  preview: string;
  urgent: boolean;
  viewing: boolean;
  dmPeerDid?: string;
}

let pending: Pending[] = [];
let burstTimer: ReturnType<typeof setTimeout> | null = null;
/** When the open burst window closes. Nothing pending and a window in the
 *  past means the next message is announced on the spot. */
let windowEndsAt = 0;

/** Test seam: a fresh module per case is not worth a vi.resetModules dance. */
export function _resetAnnounced(): void {
  announced.clear();
  pending = [];
  if (burstTimer !== null) clearTimeout(burstTimer);
  burstTimer = null;
  windowEndsAt = 0;
}

function emit(p: Pending): void {
  // Fire and forget, before the notification goes up so the mapping is on
  // disk by the time a click can arrive. A failure here costs the click its
  // routing, never the notification.
  void rememberRoomRef(p.ref, p.roomCode).catch(() => {});
  notifyMessage({
    title: p.title,
    body: p.preview,
    tag: p.tag,
    viewingConversation: p.viewing,
    urgent: p.urgent,
    data: { roomCode: p.ref, dmPeerDid: p.dmPeerDid },
  });
}

function flushBurst(): void {
  burstTimer = null;
  const items = pending;
  pending = [];
  if (items.length === 0) return;
  windowEndsAt = Date.now() + BURST_MS;

  if (items.length === 1) {
    emit(items[0]);
    return;
  }

  const first = items[0];
  const sameRoom = items.every((i) => i.roomCode === first.roomCode);
  const count = `${items.length} new messages`;
  if (sameRoom) void rememberRoomRef(first.ref, first.roomCode).catch(() => {});
  notifyMessage({
    // One conversation keeps its name, so the tap still knows where it is
    // going. Several conversations get a count and nothing else: naming one
    // of them would be a guess, and naming all of them is a lock screen full
    // of who talks to this person.
    title: sameRoom ? first.title : count,
    body: sameRoom ? count : "Open awful.chat to read them",
    tag: sameRoom ? first.tag : "mail",
    // Already a count rather than anybody's words, so the hide-preview
    // switch has nothing to take out.
    isPreview: false,
    viewingConversation: items.every((i) => i.viewing),
    urgent: items.some((i) => i.urgent),
    data: sameRoom
      ? { roomCode: first.ref, dmPeerDid: first.dmPeerDid }
      : undefined,
  });
}

function schedule(p: Pending, viaMailbox: boolean): void {
  const now = Date.now();
  // A mailbox collect is a batch by definition: even its first message waits,
  // or a five-message drain announces one and then collapses four.
  if (!viaMailbox && burstTimer === null && now >= windowEndsAt) {
    windowEndsAt = now + BURST_MS;
    emit(p);
    return;
  }
  pending.push(p);
  if (burstTimer === null) {
    if (now >= windowEndsAt) windowEndsAt = now + BURST_MS;
    burstTimer = setTimeout(flushBurst, Math.max(0, windowEndsAt - now));
  }
}

/**
 * Take down whatever is still on the lock screen for a conversation, because
 * it has just been opened and read.
 *
 * Exported for the chat view: this module only hears about conversations when
 * a message arrives in one, so it cannot see the user open a quiet room.
 */
export function clearNotificationsFor(roomCode: string): void {
  const ref = conversationRef(roomCode);
  // Both shapes: a conversation can have notified as a room and, after a
  // rename of nothing at all, still hold a dm-tagged notification.
  closeNotificationsByTag([`dm:${ref}`, `room:${ref}`]);
  // Anything not yet shown for it is answered too.
  pending = pending.filter((p) => p.roomCode !== roomCode);
}

/**
 * The opaque name a conversation goes by inside a notification.
 *
 * A notification's tag and data bag are kept by the browser, and on Android by
 * the OS, which is storage this app can neither lock nor shred - and the room
 * code is the room's entire membership secret. Unkeyed on purpose: the ref is
 * minted while the app is unlocked but has to survive being read back with no
 * key at all, and a 65-bit room code behind SHA-256 gives nothing away.
 * notify-intents.ts keeps the sealed ref -> room code mapping so the click
 * still finds the conversation.
 */
export function conversationRef(roomCode: string): string {
  return `${ROOM_REF_PREFIX}${hashRef(roomCode)}`;
}

/**
 * Announce a message the caller has established is genuinely new.
 *
 * Claims the id first, so the second delivery of the same message is silent
 * even when both delivery paths read storage before either wrote. Never
 * throws: this runs between storing a message and painting it, and an
 * escaping error there turns "stored" into "invisible until refresh".
 */
export function announceMessage(
  msg: Message,
  ctx: AnnounceContext,
  opts: {
    /** Collected from the offline mailbox, so it arrived as part of a batch
     *  even when the caller hands the messages over one at a time. */
    viaMailbox?: boolean;
  } = {}
): void {
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
    // DM files and plugin cards ride the room broadcast path too, so this has
    // to be able to speak both shapes.
    const isDm = msg.roomCode.startsWith("dm-");
    // A DM is addressed to you by construction, so it counts as a mention for
    // a conversation turned down to mentions only.
    const mentioned = isDm || mentionsMe(msg.content ?? "", ctx.selfIds);
    const mode = getRoomNotifyMode(msg.roomCode);
    if (mode === "muted") return;
    if (mode === "mentions" && !mentioned) return;

    // The conversation on screen is being read: whatever it still has on the
    // lock screen is answered, not left for the user to swipe away.
    if (ctx.uiRoomCode === msg.roomCode) clearNotificationsFor(msg.roomCode);

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

    let title: string;
    let preview: string;
    if (isDm) {
      // In a DM the sender IS the conversation; naming them twice is noise.
      title = msg.senderName;
      preview = body;
    } else if (mentioned) {
      title = `${msg.senderName} mentioned you`;
      preview = `${msg.senderName}: ${body}`;
    } else {
      // The message's OWN room, not the one on screen: titling a background
      // room's message with the open room's name pointed the reader at the
      // wrong conversation. An unnamed room falls back to a generic label,
      // NEVER to the code - a notification is read on a lock screen, over a
      // shoulder, and the code is the room's membership secret.
      title =
        roomsStore.rooms.find((r) => r.roomCode === msg.roomCode)?.name ||
        "New message";
      preview = `${msg.senderName}: ${body}`;
    }

    const ref = conversationRef(msg.roomCode);
    schedule(
      {
        roomCode: msg.roomCode,
        ref,
        tag: `${isDm ? "dm" : "room"}:${ref}`,
        title,
        preview,
        urgent: mentioned,
        viewing: ctx.uiRoomCode === msg.roomCode,
        // An inbound DM's sender IS the other side of the conversation, so a
        // click on the notification routes straight back to it.
        dmPeerDid: isDm ? msg.senderDid || msg.senderId : undefined,
      },
      opts.viaMailbox ?? false
    );
  } catch (err) {
    console.warn("[chat] notification failed:", err);
  }
}
