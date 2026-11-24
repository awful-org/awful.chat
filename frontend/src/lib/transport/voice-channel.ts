/**
 * Voice channels: several calls in one room, a person in at most one.
 *
 * A voice channel is not a room of its own. The transport room, its
 * membership and its chat stay one; the audio never went through the room
 * anyway (it is the P2P mesh or the SFU). What the room carries is the
 * signalling of who is in a call, so a channel is a tag on that signalling
 * and a call is named by (roomCode, voiceChannel).
 *
 * The empty string is the DEFAULT channel: the room's original call, with
 * exactly the wire format it always had. Old app versions and DMs only ever
 * know that one.
 */

// One definition of a channel id and of the default channel, shared with
// the channel list ($lib/channels.ts). Whether an id is in a room's list is
// deliberately not asked here: any well-formed id is a valid call tag. The
// list arrives over sync like any other room state, and a call in a channel
// whose entry has not reached us yet must still connect.
import { DEFAULT_VOICE_CHANNEL, isChannelId } from "../channels";
export { DEFAULT_VOICE_CHANNEL, isChannelId };

export function isVoiceChannel(value: unknown): value is string {
  return value === DEFAULT_VOICE_CHANNEL || isChannelId(value);
}

/**
 * Channels exist in group rooms only. A DM has just its one call: its call
 * cards, its "missed call" and its end-of-call bookkeeping all assume so.
 */
export function roomHasVoiceChannels(roomCode: string): boolean {
  return !roomCode.startsWith("dm-");
}

/** Which call: the room, and the voice channel within it. */
export interface CallTag {
  roomCode: string;
  voiceChannel: string;
}

export function sameCall(
  a: CallTag | null | undefined,
  b: CallTag | null | undefined
): boolean {
  return !!a && !!b && a.roomCode === b.roomCode && a.voiceChannel === b.voiceChannel;
}

/**
 * The CallPresence frame for a call (or for no call).
 *
 * The default channel keeps the old frame byte for byte: `roomCode` names the
 * room, and there is no channel field. Any other channel names its room in
 * `voiceRoomCode` instead, and leaves `roomCode` out. That is on purpose: an
 * old client reads only `inCall` and `roomCode`, and to it a frame with no
 * `roomCode` means "not in a call it can name". So somebody in a channel an
 * old client cannot join simply is not in its call, rather than a member of
 * its default call that it keeps dialling and that never answers.
 */
export function callPresenceFields(
  call: CallTag | null
): { inCall: boolean; roomCode?: string; voiceRoomCode?: string; voiceChannel?: string } {
  if (!call) return { inCall: false, roomCode: undefined };
  if (call.voiceChannel === DEFAULT_VOICE_CHANNEL) return { inCall: true, roomCode: call.roomCode };
  return { inCall: true, voiceRoomCode: call.roomCode, voiceChannel: call.voiceChannel };
}

/**
 * Which call a CallPresence frame puts its sender in, or null for none.
 *
 * Null covers leaving, and also every frame that does not name a call
 * cleanly: no room, a malformed channel id, a channel in a DM, a frame that
 * names its room both ways. Treating those as "not in a call" is what an
 * unrecognised room already got, and is what an old client makes of a
 * channel frame. Whether the sender may be in that room at all is not
 * decided here: the transport checks membership.
 */
export function callFromPresence(frame: unknown): CallTag | null {
  if (!frame || typeof frame !== "object") return null;
  const f = frame as Record<string, unknown>;
  if (f.inCall !== true) return null;
  if (f.voiceChannel === undefined) {
    if (f.voiceRoomCode !== undefined) return null;
    if (typeof f.roomCode !== "string" || !f.roomCode) return null;
    return { roomCode: f.roomCode, voiceChannel: DEFAULT_VOICE_CHANNEL };
  }
  // The default channel is said by leaving the field out, never by "".
  if (!isChannelId(f.voiceChannel)) return null;
  if (f.roomCode !== undefined) return null;
  if (typeof f.voiceRoomCode !== "string" || !f.voiceRoomCode) return null;
  if (!roomHasVoiceChannels(f.voiceRoomCode)) return null;
  return { roomCode: f.voiceRoomCode, voiceChannel: f.voiceChannel };
}

/** A peer's call from the two roster maps, or null if it is in none. */
export function callOfPeer(
  rooms: ReadonlyMap<string, string>,
  channels: ReadonlyMap<string, string>,
  peerId: string
): CallTag | null {
  const roomCode = rooms.get(peerId);
  if (!roomCode) return null;
  return { roomCode, voiceChannel: channels.get(peerId) ?? DEFAULT_VOICE_CHANNEL };
}

/** Everyone the roster places in this one call. */
export function peersInCall(
  rooms: ReadonlyMap<string, string>,
  channels: ReadonlyMap<string, string>,
  call: CallTag
): string[] {
  const peers: string[] = [];
  for (const [peerId, roomCode] of rooms) {
    if (roomCode !== call.roomCode) continue;
    if ((channels.get(peerId) ?? DEFAULT_VOICE_CHANNEL) === call.voiceChannel) peers.push(peerId);
  }
  return peers;
}

/**
 * Who is in each voice channel of one room: channel id -> peer ids. The
 * default channel is always there, empty or not, so the room's original call
 * has a place to be drawn; another channel appears only while somebody is in
 * it. `self` adds us to the channel we are in, when it is this room.
 */
export function voiceChannelRoster(
  rooms: ReadonlyMap<string, string>,
  channels: ReadonlyMap<string, string>,
  roomCode: string,
  self?: { peerId: string; call: CallTag | null }
): Map<string, string[]> {
  const roster = new Map<string, string[]>([[DEFAULT_VOICE_CHANNEL, []]]);
  const add = (channel: string, peerId: string) => {
    const list = roster.get(channel);
    if (list) list.push(peerId);
    else roster.set(channel, [peerId]);
  };
  if (self?.call && self.call.roomCode === roomCode) add(self.call.voiceChannel, self.peerId);
  for (const [peerId, theirRoom] of rooms) {
    if (theirRoom !== roomCode || peerId === self?.peerId) continue;
    add(channels.get(peerId) ?? DEFAULT_VOICE_CHANNEL, peerId);
  }
  return roster;
}
