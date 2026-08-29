// Refusal bookkeeping for the sync repair loop, lifted out of
// transport.svelte.ts so it can be tested: that module builds a libp2p node at
// import time, which no test environment can load.
//
/**
 * History we refused for good this session, per room, per claimed sender.
 *
 * A deterministically rejected row (unsigned in a signed room, or the retired
 * v1 canonical) has to be CLAIMED in the digest or every peer holding it
 * re-offers it on every repair tick forever - the sync storm _handleSyncBatch
 * describes. But its senderId and lamport are attacker-chosen, and a stored
 * watermark is permanent (setWatermark never regresses), so writing one
 * straight to the store lets any peer name a victim plus a huge lamport and
 * blackhole that sender's real history in this room for good.
 *
 * Split the claim by what we can corroborate. Up to the highest lamport we
 * already hold from that sender it goes to the store, where it survives a
 * reload and can hide nothing the protocol did not already treat as held.
 * Above that - which is the WHOLE claim for the peer that needs it most, a
 * fresh joiner in a legacy room holding nothing to bound it with - it lives
 * here, in memory: our digests advertise it, so the re-pushes stop for this
 * session, and a reload wipes the slate. A lie then costs the liar a fresh
 * session per attempt, and the truth costs us one re-push per reload.
 */
export const _refusedLamports = new Map<string, { at: number; senders: Map<string, number> }>();
/**
 * Senders are attacker-invented strings, so this map must not grow freely.
 * The cap is PER ROOM, not global. A single global counter meant one frame
 * naming 4096 invented senders exhausted it for every room at once and never
 * gave any of it back - disarming the anti-storm mechanism process-wide, which
 * is a cheaper and more durable attack than the blackhole the cap was guarding.
 * Rooms are bounded by what we actually joined (_handleSyncBatch requires the
 * room in _transport.rooms()), so per-room is still bounded overall.
 */
export const REFUSED_MAX_SENDERS = 4096;
/**
 * How long a refusal claim is honoured. These claims are uncorroborated by
 * design - the ceiling that would corroborate them (only claim up to a lamport
 * we already hold) costs a whole-room read per batch, and a fresh joiner in a
 * legacy room holds nothing to bound it with. Expiring them instead buys back
 * most of that: an honest claim only has to hold long enough to stop the
 * storm (peers re-offer on a 15s repair tick, so this is ~40 ticks), and a
 * forged one self-heals rather than lasting the whole session.
 */
export const REFUSED_TTL_MS = 10 * 60 * 1000;

function _refusedFor(
  roomCode: string,
  create: boolean
): Map<string, number> | undefined {
  const entry = _refusedLamports.get(roomCode);
  if (entry && Date.now() - entry.at < REFUSED_TTL_MS) return entry.senders;
  if (entry) _refusedLamports.delete(roomCode);
  if (!create) return undefined;
  const senders = new Map<string, number>();
  _refusedLamports.set(roomCode, { at: Date.now(), senders });
  return senders;
}

export function _noteRefused(
  roomCode: string,
  senderId: string,
  lamport: number
): void {
  const perRoom = _refusedFor(roomCode, true)!;
  const at = perRoom.get(senderId);
  if (at === undefined) {
    // Full means we stop claiming - falling back to the storm, never to
    // unbounded memory.
    if (perRoom.size >= REFUSED_MAX_SENDERS) return;
    perRoom.set(senderId, lamport);
  } else if (lamport > at) {
    perRoom.set(senderId, lamport);
  }
}

/** Stored watermarks plus this session's refused claims - what we advertise. */
export function _withRefused(
  roomCode: string,
  watermarks: Record<string, number>
): Record<string, number> {
  const perRoom = _refusedFor(roomCode, false);
  if (!perRoom) return watermarks;
  for (const [senderId, lamport] of perRoom) {
    if ((watermarks[senderId] ?? -1) < lamport) watermarks[senderId] = lamport;
  }
  return watermarks;
}

/** Test seam: drop every claim, as a reload would. */
export function _clearRefused(): void {
  _refusedLamports.clear();
}
