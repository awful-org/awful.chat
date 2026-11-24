/**
 * What the sidebar's channel column shows for the selected room.
 *
 * The sidebar renders these and nothing else; it never reads the transport
 * or storage for channels itself. AppView fills them from the room's channel
 * list (rooms.svelte.ts roomChannels) and the voice roster
 * (transport/voice-channels.ts), and passes the create/rename/delete/reorder
 * handlers only for a room that can have channels; the sidebar shows its
 * "+" buttons and its management items only when those exist.
 */
import type { CallBadges } from "./call-status.svelte";
import { hasOneChat, type RoomNotifyMode as NotifyMode } from "./channel-ui";

export type ChannelKind = "text" | "voice";

/** The default channel of each kind: the room's chat, and the room's call. */
export const DEFAULT_CHANNEL_ID = "";

export interface SidebarTextChannel {
  id: string;
  name: string;
  unread: number;
  /** Drawn muted: its notifications are off. Its unread still counts. */
  muted: boolean;
  /** How loud it is (its own mode, or its room's). Absent: no notify items. */
  notifyMode?: NotifyMode;
  /** The mode picked for this channel itself; null when it follows the room. */
  notifyOwn?: NotifyMode | null;
}

export interface SidebarVoicePerson {
  peerId: string;
  name: string;
  avatarUrl?: string | null;
  speaking: boolean;
  muted: boolean;
  /** What they say they are doing, as badges after their name. */
  badges?: CallBadges;
  /** This user: listed like the others, but with no menu (nothing to DM or block). */
  self?: boolean;
}

export interface SidebarVoiceChannel {
  id: string;
  name: string;
  people: SidebarVoicePerson[];
  /** This user is in this channel's call. */
  joined: boolean;
  /** In nobody's list (UNLISTED_VOICE_NAME): shown last, and has no place to move. */
  unlisted?: true;
}

/** Everything the column needs for the selected room's channels. */
export interface SidebarChannels {
  text: SidebarTextChannel[];
  voice: SidebarVoiceChannel[];
  /** The text channel on screen; DEFAULT_CHANNEL_ID for the room's chat. */
  selectedTextId: string;
  onSelectChannel: (id: string) => void;
  onJoinVoice: (id: string) => void;
  /** Make a channel with the name typed into the sidebar's inline field. */
  onCreateChannel?: (kind: ChannelKind, name: string) => void;
  onRenameChannel?: (kind: ChannelKind, id: string, name: string) => void;
  onDeleteChannel?: (kind: ChannelKind, id: string) => void;
  /**
   * That kind's channels after a move, as ids, the original one (the empty
   * id) among them.
   */
  onReorderChannels?: (kind: ChannelKind, order: string[]) => void;
  /** The room's own notification mode: what a channel that follows it gets. */
  roomNotifyMode?: NotifyMode;
  /**
   * Set a text channel's mode; null makes it follow the room again. In a room
   * with one chat (hasOneChat) the mode is the room's.
   */
  onSetNotify?: (id: string, mode: NotifyMode | null) => void;
}

// ── Building the column from the channel list and the call roster ────────────

/** Names an occupied voice channel that the room's list does not (yet) hold. */
export const UNLISTED_VOICE_NAME = "Unlisted call";

/**
 * The text section: the room's live text channels in list order, each with
 * its unread count and notification state.
 *
 * In a room with no other text channel the original chat's mode is the
 * room's: the header bell and the rail tile already say so, and the row stays
 * as it was before channels (never drawn muted). Once there are others it has
 * its own, and is drawn the way they are.
 */
export function buildTextChannels(
  list: readonly { id: string; name: string }[],
  unreadOf: (id: string) => number,
  notifyOf: (id: string) => { mode: NotifyMode; own: NotifyMode | null }
): SidebarTextChannel[] {
  const onlyDefault = hasOneChat(list);
  return list.map((c) => {
    const notify = notifyOf(c.id);
    const quiet = c.id === DEFAULT_CHANNEL_ID && onlyDefault;
    return {
      id: c.id,
      name: c.name,
      unread: unreadOf(c.id),
      muted: !quiet && notify.mode === "muted",
      notifyMode: notify.mode,
      notifyOwn: notify.own,
    };
  });
}

export interface VoiceOccupant {
  peerId: string;
  /** This device. */
  self: boolean;
}

/**
 * The voice section: every channel in the room's list, in order, with who
 * is in it - you first, then the others by name - and whether you are.
 *
 * A channel somebody is in that the list does not hold (an entry that has
 * not reached us yet, or one deleted while people were still in it) is
 * listed after the rest rather than hiding the people in it.
 */
export function buildVoiceChannels(
  list: readonly { id: string; name: string }[],
  occupancy: ReadonlyMap<string, readonly VoiceOccupant[]>,
  joinedId: string | null,
  person: (member: VoiceOccupant) => SidebarVoicePerson
): SidebarVoiceChannel[] {
  const channels: { id: string; name: string; unlisted?: true }[] = [...list];
  const listed = new Set(list.map((c) => c.id));
  for (const [id, members] of occupancy) {
    if (!listed.has(id) && members.length > 0) channels.push({ id, name: UNLISTED_VOICE_NAME, unlisted: true });
  }
  return channels.map((c) => {
    const members = occupancy.get(c.id) ?? [];
    const selves = members.filter((m) => m.self).map(person);
    const others = members
      .filter((m) => !m.self)
      .map(person)
      .sort((a, b) => a.name.localeCompare(b.name));
    const row = { id: c.id, name: c.name, people: [...selves, ...others], joined: joinedId === c.id };
    return c.unlisted ? { ...row, unlisted: true } : row;
  });
}

/**
 * The rail tile of the room on screen: what is unread in its channels other
 * than the one being read. 0 in a room with only its original chat, as the
 * room on screen always showed.
 */
export function onScreenRoomUnread(
  text: readonly Pick<SidebarTextChannel, "id" | "unread">[],
  selectedTextId: string
): number {
  return text.reduce((sum, c) => (c.id === selectedTextId ? sum : sum + c.unread), 0);
}

/**
 * Whether tapping a room's tile on a phone leaves the drawer open: only when
 * the room has a channel beyond its original chat and call to pick from. A
 * room with only those opens straight onto its chat, as before.
 */
export function roomHasChannelsToPick(
  text: readonly { id: string }[],
  voice: readonly { id: string }[]
): boolean {
  return [...text, ...voice].some((c) => c.id !== DEFAULT_CHANNEL_ID);
}

/** A kind's channels that have a place in the room's order, as ids. */
export function orderedChannelIds(list: readonly { id: string; unlisted?: true }[]): string[] {
  return list.filter((c) => !c.unlisted).map((c) => c.id);
}

/**
 * The order the sidebar hands onReorderChannels after moving one channel a
 * step, the original among them like any other. Null when the move goes
 * nowhere.
 */
export function channelMoveOrder(
  ids: readonly string[],
  id: string,
  step: -1 | 1
): string[] | null {
  const from = ids.indexOf(id);
  const to = from + step;
  if (from === -1 || to < 0 || to >= ids.length) return null;
  const next = [...ids];
  next.splice(from, 1);
  next.splice(to, 0, id);
  return next;
}

/**
 * The channels of one kind a drag can lift, in list order: all of them, or
 * none where there is only one and nowhere to move it.
 */
export function draggableChannelIds(ids: readonly string[]): string[] {
  return ids.length > 1 ? [...ids] : [];
}

/**
 * The order the sidebar hands onReorderChannels after a drag dropped `id`
 * at index `to` among the draggable channels (draggableChannelIds) - the
 * drag's twin of channelMoveOrder. Null when the drop changes nothing.
 */
export function channelDropOrder(
  ids: readonly string[],
  id: string,
  to: number
): string[] | null {
  const movable = draggableChannelIds(ids);
  const from = movable.indexOf(id);
  if (from === -1 || !Number.isInteger(to)) return null;
  const at = Math.max(0, Math.min(to, movable.length - 1));
  if (at === from) return null;
  const next = [...movable];
  next.splice(from, 1);
  next.splice(at, 0, id);
  return next;
}

/**
 * Rooms with a call going on: anyone's call presence names them, or this
 * user is in their call. Drives the live marker on the rail.
 */
export function roomsWithCalls(
  callPeerRooms: ReadonlyMap<string, string>,
  selfCallRoom: string | null
): Set<string> {
  const live = new Set(callPeerRooms.values());
  if (selfCallRoom) live.add(selfCallRoom);
  return live;
}
