/**
 * What the sidebar's channel column shows for the selected room.
 *
 * The sidebar renders these and nothing else; it never reads the transport
 * or storage for channels itself. Today AppView fills them with stand-ins:
 * one text channel (the room's chat) and one voice channel (the room's one
 * call), both with the empty id. When rooms get real text and voice channels,
 * AppView swaps the stand-ins for the channel list and the voice occupancy
 * APIs and passes the create/rename/delete/reorder handlers; the sidebar
 * shows its "+" buttons and its channel menu only once those exist.
 */

export type ChannelKind = "text" | "voice";

/** The default channel of each kind: the room's chat, and the room's call. */
export const DEFAULT_CHANNEL_ID = "";

export interface SidebarTextChannel {
  id: string;
  name: string;
  unread: number;
  muted: boolean;
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
  onCreateChannel?: (kind: ChannelKind) => void;
  onRenameChannel?: (kind: ChannelKind, id: string, name: string) => void;
  onDeleteChannel?: (kind: ChannelKind, id: string) => void;
  /** The full order of that kind's channels after a move, as ids. */
  onReorderChannels?: (kind: ChannelKind, order: string[]) => void;
}

// ── Stand-ins until the channel APIs land ───────────────────────────────────

/** The room's chat as its one text channel. */
export function defaultTextChannels(unread: number): SidebarTextChannel[] {
  return [{ id: DEFAULT_CHANNEL_ID, name: "general", unread, muted: false }];
}

export interface CallRoster {
  /** peerId -> room code of the call they are in (transportState.callPeerRooms). */
  callPeerRooms: ReadonlyMap<string, string>;
  /** Mute state each peer announced (transportState.callPeerStates). */
  callPeerStates: ReadonlyMap<string, { muted: boolean }>;
  /** Who is speaking right now (speakers.speaking), by the same ids. */
  speaking: ReadonlySet<string>;
  self: {
    /** The id speaker detection uses for this user (selfId()). */
    id: string;
    /** The transport's own peer id, so a roster echo of us is not listed twice. */
    peerId: string;
    inCall: boolean;
    callRoomCode: string | null;
    muted: boolean;
    name: string;
    avatarUrl?: string | null;
  };
  /** Display name and avatar for a peer in the call. */
  describe: (peerId: string) => { name: string; avatarUrl?: string | null };
}

/**
 * The room's one call as its one voice channel: you first when you are in
 * it, then everyone whose call presence names this room, by name.
 */
export function defaultVoiceChannels(roomCode: string, roster: CallRoster): SidebarVoiceChannel[] {
  const { self } = roster;
  const joined = self.inCall && self.callRoomCode === roomCode;
  const others: SidebarVoicePerson[] = [];
  for (const [peerId, room] of roster.callPeerRooms) {
    if (room !== roomCode || peerId === self.peerId || peerId === self.id) continue;
    const who = roster.describe(peerId);
    others.push({
      peerId,
      name: who.name,
      avatarUrl: who.avatarUrl ?? null,
      speaking: roster.speaking.has(peerId),
      muted: !!roster.callPeerStates.get(peerId)?.muted,
    });
  }
  others.sort((a, b) => a.name.localeCompare(b.name));
  const people: SidebarVoicePerson[] = joined
    ? [
        {
          peerId: self.id,
          name: self.name,
          avatarUrl: self.avatarUrl ?? null,
          speaking: roster.speaking.has(self.id),
          muted: self.muted,
        },
        ...others,
      ]
    : others;
  return [{ id: DEFAULT_CHANNEL_ID, name: "voice", people, joined }];
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
