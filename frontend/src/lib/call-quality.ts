/**
 * Pure per-peer voice call quality derivation, split out of CallStatus.svelte
 * so it is unit testable without mounting Svelte.
 *
 * The component used to hold ONE shared quality value for the whole call.
 * That let a single peer's "degraded" event paint every tile "poor
 * connection", and let any OTHER peer's track arriving repaint the whole
 * badge healthy again a moment later - erasing a real, ongoing degradation
 * that had nothing to do with the peer whose track just showed up
 * (voice-audit finding 8). Keying every verdict by peerId makes that
 * impossible: one peer's state can only ever overwrite its own entry.
 */

export type PeerVoiceQuality = "p2p" | "relayed" | "degraded" | "failed";

const QUALITY_RANK: Record<PeerVoiceQuality, number> = {
  p2p: 0,
  relayed: 0,
  degraded: 1,
  failed: 2,
};

export type CallQualityStatusEvent =
  | { type: "voice-ice-connected"; peerId: string; relayed: boolean }
  | { type: "voice-connection-failed"; peerId: string }
  | { type: "voice-degraded"; peerId: string }
  | { type: "voice-peer-left"; peerId: string };

function withPeer(
  peers: ReadonlyMap<string, PeerVoiceQuality>,
  peerId: string,
  quality: PeerVoiceQuality
): ReadonlyMap<string, PeerVoiceQuality> {
  if (peers.get(peerId) === quality) return peers;
  const next = new Map(peers);
  next.set(peerId, quality);
  return next;
}

/**
 * Apply one transport status event to the per-peer quality map. Returns the
 * SAME map instance when nothing changed, so a caller assigning the result
 * into `$state` can skip a reactive update.
 */
export function applyCallQualityStatus(
  peers: ReadonlyMap<string, PeerVoiceQuality>,
  event: CallQualityStatusEvent
): ReadonlyMap<string, PeerVoiceQuality> {
  switch (event.type) {
    case "voice-ice-connected":
      return withPeer(peers, event.peerId, event.relayed ? "relayed" : "p2p");
    case "voice-connection-failed":
      return withPeer(peers, event.peerId, "failed");
    case "voice-degraded":
      return withPeer(peers, event.peerId, "degraded");
    case "voice-peer-left": {
      if (!peers.has(event.peerId)) return peers;
      const next = new Map(peers);
      next.delete(event.peerId);
      return next;
    }
  }
}

/**
 * A track is proof a peer has SOME link, but says nothing about the path -
 * never overwrite an existing verdict (an ICE event, or a prior failure)
 * with the mere fact that a track arrived. Only fills in peers with no
 * verdict yet, so an unrelated peer's track can never erase this peer's
 * degradation.
 */
export function noteTrackAdded(
  peers: ReadonlyMap<string, PeerVoiceQuality>,
  peerId: string
): ReadonlyMap<string, PeerVoiceQuality> {
  if (peers.has(peerId)) return peers;
  return withPeer(peers, peerId, "p2p");
}

/** Worst (most alarming) quality across every peer with a known verdict. */
export function worstQuality(
  peers: ReadonlyMap<string, PeerVoiceQuality>
): PeerVoiceQuality | null {
  let worst: PeerVoiceQuality | null = null;
  for (const q of peers.values()) {
    if (worst === null || QUALITY_RANK[q] > QUALITY_RANK[worst]) worst = q;
  }
  return worst;
}
