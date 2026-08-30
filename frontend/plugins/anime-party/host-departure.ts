/**
 * Detects the party's host disconnecting and gives them a grace window to
 * reconnect before the party auto-closes.
 *
 * Mirrors the pattern the ecosystem's watch-together plugin already uses
 * for exactly this problem (a member disconnecting mid-call-setup is
 * common and must not be mistaken for the host leaving for good): start a
 * timer on disconnect, cancel it the moment the host's peer connection is
 * observed again, and only act once the timer actually elapses. 15s keeps
 * the original 5s tolerance as a floor while giving a call renegotiation
 * room to finish first.
 */

export interface PeerLike {
  did: string;
}

export interface HostDepartureGrace {
  /** Call from `host.onPeerDisconnect` for every peer that drops. */
  observeDisconnect(did: string): void;
  /** Call periodically (or whenever `host.peers()` might have changed) so a
   *  returning host cancels the pending close. */
  observePeers(): void;
  /** Call on unmount. Leaves no timer running past the component's life. */
  dispose(): void;
}

export const HOST_DEPARTURE_GRACE_MS = 15_000;

export function createHostDepartureGrace(
  hostDid: string,
  peers: () => PeerLike[],
  onGraceElapsed: () => void,
  delayMs = HOST_DEPARTURE_GRACE_MS
): HostDepartureGrace {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function observePeers(): void {
    if (!timer || !peers().some((peer) => peer.did === hostDid)) return;
    clearTimeout(timer);
    timer = null;
  }

  function observeDisconnect(did: string): void {
    if (!hostDid || did !== hostDid || timer) return;
    timer = setTimeout(() => {
      timer = null;
      if (!peers().some((peer) => peer.did === hostDid)) onGraceElapsed();
    }, delayMs);
  }

  function dispose(): void {
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { observeDisconnect, observePeers, dispose };
}
