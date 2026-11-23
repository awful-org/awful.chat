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
import type { RoomNotifyMode as NotifyMode } from "./channel-ui";

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
}

export interface SidebarVoiceChannel {
  id: string;
  name: string;
  people: SidebarVoicePerson[];
  /** This user is in this channel's call. */
  joined: boolean;
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
   * That kind's channels after a move, as ids, the original one left out
   * (it is always first and never moves; see channelMoveOrder).
   */
  onReorderChannels?: (kind: ChannelKind, order: string[]) => void;
  /** The room's own notification mode: what a channel that follows it gets. */
  roomNotifyMode?: NotifyMode;
  /** Set a text channel's mode; null makes it follow the room again. */
  onSetNotify?: (id: string, mode: NotifyMode | null) => void;
}

// ── Building the column from the channel list and the call roster ────────────

/** Names an occupied voice channel that the room's list does not (yet) hold. */
export const UNLISTED_VOICE_NAME = "Unlisted call";

/**
 * The text section: the room's live text channels in list order, each with
 * its unread count and notification state.
 *
 * The original chat's own mode IS the room's. In a room with no other text
 * channel the header bell already says so, and the row stays as it was
 * before channels (never drawn muted); once there are others it is drawn
 * the way they are.
 */
export function buildTextChannels(
  list: readonly { id: string; name: string }[],
  unreadOf: (id: string) => number,
  notifyOf: (id: string) => { mode: NotifyMode; own: NotifyMode | null }
): SidebarTextChannel[] {
  const onlyDefault = list.every((c) => c.id === DEFAULT_CHANNEL_ID);
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
  const channels = [...list];
  const listed = new Set(list.map((c) => c.id));
  for (const [id, members] of occupancy) {
    if (!listed.has(id) && members.length > 0) channels.push({ id, name: UNLISTED_VOICE_NAME });
  }
  return channels.map((c) => {
    const members = occupancy.get(c.id) ?? [];
    const selves = members.filter((m) => m.self).map(person);
    const others = members
      .filter((m) => !m.self)
      .map(person)
      .sort((a, b) => a.name.localeCompare(b.name));
    return { id: c.id, name: c.name, people: [...selves, ...others], joined: joinedId === c.id };
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

/**
 * The order the sidebar hands onReorderChannels after moving one channel a
 * step: the original channel stays first and does not move, and nothing
 * moves above it. Null when the move goes nowhere.
 */
export function channelMoveOrder(
  ids: readonly string[],
  id: string,
  step: -1 | 1
): string[] | null {
  if (id === DEFAULT_CHANNEL_ID) return null;
  const movable = ids.filter((c) => c !== DEFAULT_CHANNEL_ID);
  const from = movable.indexOf(id);
  const to = from + step;
  if (from === -1 || to < 0 || to >= movable.length) return null;
  const next = [...movable];
  next.splice(from, 1);
  next.splice(to, 0, id);
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
