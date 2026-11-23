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

export function getRoomNotifyMode(roomCode: string): RoomNotifyMode {
  return prefs.modes[hashRef(roomCode)] ?? "all";
}

/**
 * Set how loud a room may be.
 *
 * Muting a room is "no sound from this room", so it also takes back the
 * louder modes its channels kept from before (`channels`: the room's channel
 * ids): a channel set to "all messages" while the room was loud would
 * otherwise go on beeping in a room the user has just muted. Those channels
 * follow the room again; one that should stay loud is unmuted again from its
 * own menu, after this, and then keeps that.
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
  if (mode !== "muted") return;
  let dropped = false;
  for (const channel of channels) {
    if (!channel) continue;
    const cref = channelRef(roomCode, channel);
    const own = channelPrefs.modes[cref];
    if (own === undefined || own === "muted") continue;
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
// channel can stay loud in a muted room. Kept apart from the room modes,
// under the same hashed keys (of the room and the channel together), so a
// build without channels reads its room map exactly as before.

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

/**
 * The mode picked for one channel, or null when it follows its room. The
 * original chat ("") has no mode of its own: it is the room's.
 */
export function getChannelNotifyMode(roomCode: string, channel: string): RoomNotifyMode | null {
  if (!channel) return null;
  return channelPrefs.modes[channelRef(roomCode, channel)] ?? null;
}

/** Pick a channel's mode, or null to have it follow its room again. */
export function setChannelNotifyMode(
  roomCode: string,
  channel: string,
  mode: RoomNotifyMode | null
): void {
  if (!channel) {
    if (mode) setRoomNotifyMode(roomCode, mode);
    return;
  }
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
