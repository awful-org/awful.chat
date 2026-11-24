/**
 * Channels on screen, as plain decisions: what the chat header and the
 * composer say about the channel open, what a channel's notification menu
 * offers and what each item stores, which call the stage shows, and how the
 * call status names the call. The components render these; kept here so they
 * can be tested without a DOM.
 */
import type { RoomNotifyMode } from "./notify-prefs.svelte";
import { DEFAULT_TEXT_CHANNEL, DEFAULT_VOICE_CHANNEL } from "./channels";
import type { CallTag } from "./transport/voice-channel";

export type { RoomNotifyMode };

// ── The channel on screen ───────────────────────────────────────────────────

/** Whether a conversation's only chat is its original one: a room with no other text channel, or a DM. */
export function hasOneChat(textChannels: readonly { id: string }[]): boolean {
  return textChannels.every((c) => c.id === DEFAULT_TEXT_CHANNEL);
}

/**
 * The channel name the chat header shows beside the room's ("#name"), or
 * null to show the room's name alone: a room with only its original chat
 * looks as it did before channels.
 */
export function channelHeading(
  textChannels: readonly { id: string; name: string }[],
  current: string
): string | null {
  if (hasOneChat(textChannels)) return null;
  return textChannels.find((c) => c.id === current)?.name ?? null;
}

/** The composer's placeholder: it names the channel once there is a choice. */
export function composerPlaceholder(heading: string | null, mobile: boolean): string {
  if (heading) return `Message #${heading}`;
  return mobile ? "Message..." : "Type a message...";
}

// ── Notifications ───────────────────────────────────────────────────────────

/** The chat header's wording, unchanged from before channels. */
export const NOTIFY_LABEL: Readonly<Record<RoomNotifyMode, string>> = {
  all: "All messages",
  mentions: "Mentions only",
  muted: "Muted",
};

/** The header bell cycles: all, mentions only, muted, all. */
export const NOTIFY_NEXT: Readonly<Record<RoomNotifyMode, RoomNotifyMode>> = {
  all: "mentions",
  mentions: "muted",
  muted: "all",
};

/**
 * What to store for a channel that should now be `mode`: nothing of its own
 * (null, follow the room) when that is what the room gives it anyway, so a
 * channel only keeps a mode while it differs from its room's.
 */
export function channelModeToStore(mode: RoomNotifyMode, roomMode: RoomNotifyMode): RoomNotifyMode | null {
  return mode === roomMode ? null : mode;
}

/**
 * Whose notifications the header bell sets: the channel's on screen, the
 * original chat included, once the room has a choice of them. With one chat
 * there is one setting, the room's (or DM's), as before channels; and in a
 * muted room the room's is the one that decides.
 */
export function bellScope(
  textChannels: readonly { id: string }[],
  current: string,
  roomMode: RoomNotifyMode = "all"
): "room" | "channel" {
  if (roomMode === "muted") return "room";
  return current === DEFAULT_TEXT_CHANNEL && hasOneChat(textChannels) ? "room" : "channel";
}

/** The header bell's label: for the room, or for the channel on screen. */
export function notifyLabel(
  mode: RoomNotifyMode,
  channelName: string | null,
  roomMode: RoomNotifyMode = "all"
): string {
  // In a room of several channels: that it is all of them, not this one.
  if (channelName && roomMode === "muted") return "Notifications: Room muted";
  return channelName
    ? `Notifications for #${channelName}: ${NOTIFY_LABEL[mode]}`
    : `Notifications: ${NOTIFY_LABEL[mode]}`;
}

export interface NotifyMenuItem {
  id: "mute" | "unmute" | "mentions" | "all" | "follow";
  label: string;
  /** What setChannelNotifyMode gets: a mode, or null to follow the room. */
  mode: RoomNotifyMode | null;
}

/**
 * The notification items of a menu, for the current state of what it sets:
 * a room, or one of its text channels.
 *
 * A room's items say "room", and so do those of its only chat: there is one
 * setting between them, the room's, and saying "channel" would be a lie
 * about what happens. With other text channels the original chat is a
 * channel like them, with a mode of its own.
 *
 * A muted room is silent in every channel, so a channel's menu there has one
 * item, the room's own: no choice of the channel's would be heard.
 */
export function notifyMenuItems(opts: {
  scope: "room" | "channel";
  /** The mode in force: the channel's own, or its room's. */
  mode: RoomNotifyMode;
  /** The channel's own mode; null when it follows the room. */
  own: RoomNotifyMode | null;
  roomMode: RoomNotifyMode;
}): NotifyMenuItem[] {
  const { scope, mode, own, roomMode } = opts;
  const isRoom = scope === "room";
  const store = (m: RoomNotifyMode) => (isRoom ? m : channelModeToStore(m, roomMode));
  if (!isRoom && roomMode === "muted") return [{ id: "unmute", label: "Unmute room", mode: "all" }];
  const items: NotifyMenuItem[] = [];
  if (mode === "muted") {
    // Unmuted is "all" for the room; for a channel, whatever its room gives.
    const unmuted: RoomNotifyMode = isRoom ? "all" : roomMode;
    items.push({ id: "unmute", label: `Unmute ${scope}`, mode: store(unmuted) });
  } else {
    items.push({ id: "mute", label: `Mute ${scope}`, mode: store("muted") });
  }
  if (mode !== "mentions") items.push({ id: "mentions", label: "Mentions only", mode: store("mentions") });
  if (mode === "mentions") items.push({ id: "all", label: "All messages", mode: store("all") });
  if (!isRoom && own !== null) items.push({ id: "follow", label: "Use room setting", mode: null });
  return items;
}

// ── Calls ───────────────────────────────────────────────────────────────────

/**
 * The call the stage and the member list show for the room on screen: ours
 * when we are in a call in that room, whichever voice channel it is in;
 * otherwise the room's original call, which is the one their "Join call"
 * joins. Null with no room on screen.
 */
export function stageCall(roomOnScreen: string | null, myCall: CallTag | null): CallTag | null {
  if (!roomOnScreen) return null;
  if (myCall && myCall.roomCode === roomOnScreen) return myCall;
  return { roomCode: roomOnScreen, voiceChannel: DEFAULT_VOICE_CHANNEL };
}

/**
 * Whether the stage is above the chat. Always with the call we are in. A
 * call we are not in has one, with who is in it and the way to join, only
 * where the sidebar does not say both: it lists a room's voice channels, but
 * a DM has none, and a quick call has no sidebar.
 */
export function showsStage(opts: {
  inThisCall: boolean;
  othersInCall: boolean;
  sidebarListsCall: boolean;
}): boolean {
  return opts.inThisCall || (opts.othersInCall && !opts.sidebarListsCall);
}

/**
 * How the call status names the call: the room, and the voice channel when
 * it is not the room's original call. A channel whose entry has not reached
 * us is still named as one.
 */
export function callPlaceLabel(roomName: string, voiceChannel: string, channelName: string | null): string {
  if (voiceChannel === DEFAULT_VOICE_CHANNEL) return roomName;
  return `${roomName} · ${channelName ?? "voice channel"}`;
}
