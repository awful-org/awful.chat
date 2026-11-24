import { untrack } from "svelte";
import { NO_CALL_STATUS, type CallActivity, type CallStatus } from "./call-status";
import { displayPrefs } from "./display-prefs.svelte";
import { foldedActivity, ownActivities } from "./plugins/activity.svelte";
import { getManifest } from "./plugins/registry";
import { _sendCallState } from "./transport/call.svelte";
import { transportState } from "./transport/transport.svelte";

/** Our own status as everyone else has it: nothing, once turned off, or in no call. */
export function ownCallStatus(): Readonly<CallStatus> {
  if (!displayPrefs.shareCallStatus || !transportState.inCall) return NO_CALL_STATUS;
  return { sharing: transportState.screenSharing, activities: ownActivities(transportState.callRoomCode) };
}

/**
 * A peer's status: what they said. From an older build, whose state says
 * nothing of it, what can be seen from inside the same call - a share on
 * offer, a plugin's own account of who is doing what. Of somebody not heard
 * from yet, nothing: they may be about to say they are not telling.
 */
export function peerCallStatus(
  peerId: string | null,
  did: string,
  roomCode: string | null
): Readonly<CallStatus> {
  const state = peerId ? transportState.callPeerStates.get(peerId) : undefined;
  if (!state) return NO_CALL_STATUS;
  if (state.status) return state.status;
  const sharing = [peerId, did].some(
    (k) =>
      !!k &&
      (transportState.pendingTransmissions.has(k) || transportState.watchingTransmissions.has(k))
  );
  const activity = foldedActivity(did, roomCode);
  return { sharing, activities: activity ? [activity] : [] };
}

/** A status as the badges beside a name: a plugin's icon, null for one not here. */
export interface CallBadges {
  sharing: boolean;
  activities: { label: string; icon: string | null }[];
}

export function callBadges(status: Readonly<CallStatus>): CallBadges {
  return {
    sharing: status.sharing,
    activities: status.activities.map((a: CallActivity) => ({
      label: a.label,
      icon: getManifest(a.plugin)?.icon ?? null,
    })),
  };
}

/** A plugin may change its line as often as it likes; the room hears it this often. */
const MIN_SEND_GAP_MS = 1_000;

/**
 * Tell the call's room when our status changes. Called while a component
 * that lives as long as the call does initializes (AppView, QuickCall).
 */
export function broadcastCallStatus(): void {
  let lastSent = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const send = () => {
    timer = undefined;
    if (!transportState.inCall) return;
    lastSent = Date.now();
    _sendCallState();
  };
  const status = $derived(JSON.stringify(ownCallStatus()));
  let known: string | undefined;
  $effect(() => {
    const now = status;
    if (!transportState.inCall) {
      // The join sends the state as it is then.
      known = undefined;
      return;
    }
    if (known === undefined && now === JSON.stringify(NO_CALL_STATUS)) known = now;
    if (now === known) return;
    known = now;
    untrack(() => {
      timer ??= setTimeout(send, Math.max(0, lastSent + MIN_SEND_GAP_MS - Date.now()));
    });
  });
  $effect(() => () => clearTimeout(timer));
}
