/**
 * Which candidate pair actually carried the media, and whether it was relayed.
 *
 * `RTCIceCandidatePairStats` has no candidate TYPE in Chrome. It carries
 * `localCandidateId` and `remoteCandidateId`, and the types live on the
 * separate `local-candidate` / `remote-candidate` entries those ids point at.
 * Reading `pair.localCandidateType` therefore yields `undefined` on every
 * Chromium browser - which silently made "is this call relayed?" answer NO for
 * every Chrome user, including the ones whose audio was going through TURN.
 *
 * Firefox does expose the types on the pair, so both shapes are read: the
 * inline value first, the dereferenced one second.
 */

export interface SucceededPair {
  /** "host" | "srflx" | "prflx" | "relay", or null when unreported. */
  local: string | null;
  remote: string | null;
  /** Either end via TURN. The question every "is it my network" answer needs. */
  relayed: boolean;
  /** Round trip time in milliseconds, or null. */
  rttMs: number | null;
}

type Row = Record<string, unknown> & { type?: string };

/**
 * The nominated succeeded pair, or the first succeeded one. Returns null when
 * no pair has succeeded yet, which is itself the answer to "why is there no
 * audio" and must not be confused with a pair whose types are unknown.
 */
export function succeededPair(
  stats: Iterable<unknown> | { values(): Iterable<unknown> }
): SucceededPair | null {
  const rows: Row[] = [];
  const iterable =
    typeof (stats as { values?: unknown }).values === "function"
      ? (stats as { values(): Iterable<unknown> }).values()
      : (stats as Iterable<unknown>);
  for (const row of iterable) {
    if (row && typeof row === "object") rows.push(row as Row);
  }

  const candidates = new Map<string, Row>();
  let best: Row | null = null;
  for (const row of rows) {
    if (row.type === "local-candidate" || row.type === "remote-candidate") {
      const id = row.id;
      if (typeof id === "string") candidates.set(id, row);
      continue;
    }
    if (row.type !== "candidate-pair" || row.state !== "succeeded") continue;
    // A nominated pair beats a merely succeeded one; ICE can hold several.
    if (!best || row.nominated === true) best = row;
  }
  if (!best) return null;

  const typeOf = (inline: unknown, id: unknown): string | null => {
    if (typeof inline === "string") return inline;
    if (typeof id !== "string") return null;
    const found = candidates.get(id)?.candidateType;
    return typeof found === "string" ? found : null;
  };

  const local = typeOf(best.localCandidateType, best.localCandidateId);
  const remote = typeOf(best.remoteCandidateType, best.remoteCandidateId);
  const rtt = best.currentRoundTripTime;

  return {
    local,
    remote,
    relayed: local === "relay" || remote === "relay",
    rttMs: typeof rtt === "number" ? Math.round(rtt * 1000) : null,
  };
}
