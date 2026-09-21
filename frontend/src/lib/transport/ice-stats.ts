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
 * The transport's selected pair, then a nominated/selected succeeded pair,
 * or the first succeeded one for older browsers. Returns null when
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
  const selectedIds = new Set(
    rows
      .filter((row) => row.type === "transport")
      .map((row) => row.selectedCandidatePairId)
      .filter((id): id is string => typeof id === "string")
  );
  let best: Row | null = null;
  let bestRank = -1;
  for (const row of rows) {
    if (row.type === "local-candidate" || row.type === "remote-candidate") {
      const id = row.id;
      if (typeof id === "string") candidates.set(id, row);
      continue;
    }
    if (row.type !== "candidate-pair" || row.state !== "succeeded") continue;
    // Old nominated pairs can remain in stats after a route change.
    const rank = typeof row.id === "string" && selectedIds.has(row.id)
      ? 3
      : row.selected === true ? 2 : row.nominated === true ? 1 : 0;
    if (rank > bestRank) {
      best = row;
      bestRank = rank;
    }
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
