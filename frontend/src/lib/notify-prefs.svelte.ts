import { hashRef } from "./storage-crypto";

/**
 * notify-prefs.svelte.ts - how loud each conversation is allowed to be.
 *
 * "all" is the default and is never written: only the rooms someone has
 * actually turned down take up space, so this map stays the size of the
 * decisions made rather than the size of the room list.
 *
 * Keyed by hashRef(roomCode), NOT by the code. localStorage is plaintext on
 * disk and survives a lock, and the room code IS the room's entire membership
 * secret - the same reason announce.ts puts an opaque ref in a notification
 * rather than the code. A hash is enough to look a preference up, and gives
 * nothing away to whoever reads the file.
 */

export type RoomNotifyMode = "all" | "mentions" | "muted";

const KEY = "awful:room-notify:v1";

function isMode(v: unknown): v is RoomNotifyMode {
  return v === "all" || v === "mentions" || v === "muted";
}

function load(): Record<string, RoomNotifyMode> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, RoomNotifyMode> = {};
    for (const [ref, mode] of Object.entries(raw)) {
      if (isMode(mode) && mode !== "all") out[ref] = mode;
    }
    return out;
  } catch {
    return {};
  }
}

// A rune-backed object, so a component that reads getRoomNotifyMode() in a
// $derived repaints when the mode is changed from a menu somewhere else.
const prefs = $state<{ modes: Record<string, RoomNotifyMode> }>({
  modes: load(),
});

/**
 * The room's own mode: what a channel of it gets that has none of its own
 * (effectiveNotifyMode, which is what a message goes by).
 */
export function getRoomNotifyMode(roomCode: string): RoomNotifyMode {
  return prefs.modes[hashRef(roomCode)] ?? "all";
}

/** Whether these text channels are the original chat alone: one chat, one setting. */
function oneChat(channels: readonly string[]): boolean {
  return channels.length > 0 && channels.every((c) => c === "");
}

/**
 * How loud a room is, as its tile, its menu and the palette say it
 * (`channels`: the room's text channel ids). Its own mode - but where its
 * only chat is the original one, what that chat goes by: a chat muted while
 * the room had other channels is still muted when they are gone, and the
 * room is as quiet as it.
 */
export function roomNotifySetting(roomCode: string, channels: readonly string[]): RoomNotifyMode {
  return oneChat(channels) ? effectiveNotifyMode(roomCode) : getRoomNotifyMode(roomCode);
}

/**
 * Set how loud a room may be.
 *
 * Muting a room is "no sound from this room", so it also takes back the
 * louder modes its channels kept from before (`channels`: the room's text
 * channel ids, "" being its original chat): a channel set to "all messages"
 * while the room was loud would otherwise go on beeping in a room the user
 * has just muted. Those channels follow the room again; one that should stay
 * loud is unmuted again from its own menu, after this, and then keeps that.
 *
 * In a room whose only chat is the original one, any mode replaces what that
 * chat kept: there the room's setting is the chat's (roomNotifySetting).
 */
export function setRoomNotifyMode(
  roomCode: string,
  mode: RoomNotifyMode,
  channels: readonly string[] = []
): void {
  const ref = hashRef(roomCode);
  if (mode === "all") delete prefs.modes[ref];
  else prefs.modes[ref] = mode;
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs.modes));
  } catch {
    // Storage blocked: the choice just does not survive a reload.
  }
  const single = oneChat(channels);
  if (mode !== "muted" && !single) return;
  let dropped = false;
  for (const channel of channels) {
    const cref = channelRef(roomCode, channel);
    const own = channelPrefs.modes[cref];
    if (own === undefined || (own === "muted" && !single)) continue;
    delete channelPrefs.modes[cref];
    dropped = true;
  }
  if (!dropped) return;
  try {
    localStorage.setItem(CHANNEL_KEY, JSON.stringify(channelPrefs.modes));
  } catch {
    // Storage blocked: the choice just does not survive a reload.
  }
}

// ── per channel (channels.ts) ───────────────────────────────────────────────
//
// A channel follows its room until someone picks a mode for that channel,
// and then keeps it whatever the room is set to - "all" included, so one
// channel can stay loud in a muted room. The original chat ("") is a channel
// like the others. Kept apart from the room modes, under the same hashed keys
// (of the room and the channel together: the original chat's is the room code
// and the separator, never the room's own key), so a build without channels
// reads its room map exactly as before, and a room muted before channels is a
// muted room, not a muted original chat.

const CHANNEL_KEY = "awful:channel-notify:v1";

function channelRef(roomCode: string, channel: string): string {
  return hashRef(`${roomCode}\u0000${channel}`);
}

function loadChannels(): Record<string, RoomNotifyMode> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = JSON.parse(localStorage.getItem(CHANNEL_KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, RoomNotifyMode> = {};
    for (const [ref, mode] of Object.entries(raw)) {
      if (isMode(mode)) out[ref] = mode;
    }
    return out;
  } catch {
    return {};
  }
}

const channelPrefs = $state<{ modes: Record<string, RoomNotifyMode> }>({
  modes: loadChannels(),
});

/** The mode picked for one channel ("" for the original chat), or null when it follows its room. */
export function getChannelNotifyMode(roomCode: string, channel: string): RoomNotifyMode | null {
  // A DM has no channels, so nothing of its own apart from its one mode.
  if (roomCode.startsWith("dm-")) return null;
  return channelPrefs.modes[channelRef(roomCode, channel)] ?? null;
}

/** Pick a channel's mode, or null to have it follow its room again. */
export function setChannelNotifyMode(
  roomCode: string,
  channel: string,
  mode: RoomNotifyMode | null
): void {
  if (roomCode.startsWith("dm-")) return;
  const ref = channelRef(roomCode, channel);
  if (mode === null) delete channelPrefs.modes[ref];
  else channelPrefs.modes[ref] = mode;
  try {
    localStorage.setItem(CHANNEL_KEY, JSON.stringify(channelPrefs.modes));
  } catch {
    // Storage blocked: the choice just does not survive a reload.
  }
}

/** How loud a message in this channel of the room may be. */
export function effectiveNotifyMode(roomCode: string, channel = ""): RoomNotifyMode {
  return getChannelNotifyMode(roomCode, channel) ?? getRoomNotifyMode(roomCode);
}

// A second tab muting a room should be reflected here, not fought.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) prefs.modes = load();
    if (e.key === CHANNEL_KEY) channelPrefs.modes = loadChannels();
  });
}
