/**
 * Pure derivation of a peer's online/connecting/offline display state.
 *
 * The transport's own connected-peers membership says nothing about whether
 * a frame can actually reach the peer (libp2p-audit finding 1). A peer with
 * a connection but no proven stream used to render as a plain green
 * "Online" dot, identical to a peer whose stream is confirmed carrying
 * traffic. This computes the distinction, with a grace window so the
 * ordinary handshake - every peer is briefly connected-without-proof while
 * its stream confirms - never flickers into "Connecting" on a normal fast
 * join.
 */

export const PEER_PROOF_GRACE_MS = 3000;

export interface PeerOnlineState {
  /** Render the solid "Online" state. */
  isOnline: boolean;
  /** Render the distinct "Connecting" state - connected, but unproven past grace. */
  isConnecting: boolean;
}

/**
 * @param connected The peer is a member of the transport's connected set.
 * @param proven The peer's stream is confirmed to carry traffic.
 * @param connectedSinceMs When this peer was first seen connected, or
 *   undefined if it is not currently tracked as connected.
 * @param nowMs Current time.
 * @param graceMs Window after first connecting during which an unproven
 *   peer still reads "online" rather than "connecting".
 */
export function derivePeerOnlineState(
  connected: boolean,
  proven: boolean,
  connectedSinceMs: number | undefined,
  nowMs: number,
  graceMs: number
): PeerOnlineState {
  if (!connected) return { isOnline: false, isConnecting: false };
  if (proven) return { isOnline: true, isConnecting: false };
  const withinGrace =
    connectedSinceMs !== undefined && nowMs - connectedSinceMs < graceMs;
  return { isOnline: withinGrace, isConnecting: !withinGrace };
}
