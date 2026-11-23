/**
 * What the UI reads and calls for voice channels. No component draws these
 * yet; until one does, every call is the room's default channel and nothing
 * here changes what is on screen.
 *
 * Reads are plain functions over reactive state: called inside a $derived or
 * an effect, they rerun whenever somebody joins, leaves or moves.
 */
import { identityStore } from "$lib/identity/identity.svelte";
import { looksLikeDid } from "$lib/identity/identity-utils";
import { _transport, peerIdToDid, transportState } from "./transport.svelte";
import { voiceChannelRoster, type CallTag } from "./voice-channel";

export { joinCall, leaveCall, switchVoiceChannel } from "./call.svelte";
export { DEFAULT_VOICE_CHANNEL, isChannelId, type CallTag } from "./voice-channel";

export interface VoiceChannelMember {
  peerId: string;
  /** Their did:key once their profile has bound it, else null. */
  did: string | null;
  /** This device. */
  self: boolean;
}

/** The call this device is in - its room and voice channel - or null. */
export function currentVoiceChannel(): CallTag | null {
  const roomCode = transportState.callRoomCode;
  if (!transportState.inCall || !roomCode) return null;
  return { roomCode, voiceChannel: transportState.callVoiceChannel };
}

/**
 * Who is in each voice channel of this room right now: channel id ("" for
 * the room's default call) -> its members, this device included when it is
 * in one. The default channel is always present, even empty; any other only
 * while somebody is in it - the list of channels a room HAS is the channel
 * list's business, not the call roster's.
 *
 * Built from call presence, which only a member of the room can send us and
 * which we only send to members, so this never names anybody the room's
 * own members could not already see.
 */
export function voiceChannelsIn(roomCode: string): Map<string, VoiceChannelMember[]> {
  void transportState.peerDidVersion;
  const selfId = _transport.selfId();
  const roster = voiceChannelRoster(
    transportState.callPeerRooms,
    transportState.callPeerVoiceChannels,
    roomCode,
    { peerId: selfId, call: currentVoiceChannel() }
  );
  const members = new Map<string, VoiceChannelMember[]>();
  for (const [channel, peerIds] of roster) {
    members.set(
      channel,
      peerIds.map((peerId) => {
        if (peerId === selfId) return { peerId, did: identityStore.did ?? null, self: true };
        const did = peerIdToDid(peerId);
        return { peerId, did: looksLikeDid(did) ? did : null, self: false };
      })
    );
  }
  return members;
}
