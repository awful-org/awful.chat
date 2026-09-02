import { definePlugin, type CardCtx, type HostApi } from "$lib/plugins/api";
import { manifest } from "./manifest";
import PingCard from "./PingCard.svelte";
import {
  MAX_TARGETS,
  parsePingArgs,
  unpackSeries,
  type PackedSample,
  type Stats,
} from "./logic";

export interface PingTarget {
  did: string;
  name: string;
}

export interface PingState {
  targets: PingTarget[];
  /** Whose measurement this is. Only they probe; everyone else reads. */
  ownerDid: string;
  /** Filled in once the window closes, keyed by target DID. */
  results: Record<string, Stats>;
  /**
   * The measured points, so everybody else sees the shape and not just the
   * numbers. Only the device that ran the probes has the samples; without
   * these the card renders an empty chart for every other person in the
   * room.
   */
  series: Record<string, PackedSample[]>;
  /** Peers that were reached through a relay for the whole run. */
  relayed: string[];
}

/** Key names that mutate an object literal instead of being stored in it. */
const UNSAFE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export function initialState(cardData: unknown, ctx?: CardCtx): PingState {
  const data = cardData as Record<string, unknown> | undefined;
  const raw = Array.isArray(data?.targets) ? data.targets : [];
  const targets: PingTarget[] = [];
  for (const t of raw) {
    const did = (t as PingTarget)?.did;
    const name = (t as PingTarget)?.name;
    if (typeof did !== "string" || !did) continue;
    // Targets become KEYS of the results and series objects below. Assigning
    // `__proto__` on an object literal runs the inherited setter and swaps
    // the prototype instead of adding a key, so a card naming that as a peer
    // reached through the reducer into every plain object it built.
    if (UNSAFE_KEYS.has(did)) continue;
    if (targets.some((x) => x.did === did)) continue;
    targets.push({ did, name: typeof name === "string" ? name : did });
    if (targets.length >= MAX_TARGETS) break;
  }
  return {
    targets,
    // The HOST's sender, never `data.ownerDid`. The payload is peer-supplied,
    // so a card claiming somebody else's DID used to hand them the owner-only
    // reducer path. Empty means nobody owns it, and the reducer below refuses
    // every update - the same fail-closed shape a forged card should have.
    ownerDid: ctx?.senderDid ?? "",
    results: {},
    series: {},
    relayed: [],
  };
}

/**
 * One peer's summary, rebuilt field by field.
 *
 * `typeof x === "object"` accepted an array, a `__proto__` payload and NaN
 * for every number, and the chart divides by these. Rebuilding drops the
 * prototype with the rest of the keys.
 */
function cleanStats(raw: unknown): Stats | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const s = raw as Record<string, unknown>;
  const num = (v: unknown): number | null =>
    typeof v === "number" && Number.isFinite(v) ? v : null;
  const sent = num(s.sent);
  const loss = num(s.loss);
  if (sent === null || sent < 0 || loss === null || loss < 0 || loss > 1) {
    return null;
  }
  return {
    min: num(s.min),
    median: num(s.median),
    max: num(s.max),
    loss,
    sent,
  };
}

export function reduce(
  prev: unknown,
  update: { data: unknown },
  ctx: { senderDid: string }
): PingState {
  // The host hands state back as unknown - it does not know a plugin's
  // shape - so the narrowing happens here rather than in the signature.
  const state = prev as PingState;
  const data = update.data as Record<string, unknown>;
  // Strict, never `state.ownerDid && ...`: that guard reads as "check when
  // there is an owner" and behaves as "skip the check when there is not".
  if (ctx.senderDid !== state.ownerDid) return state;
  if (data?.action !== "result") return state;
  const results = data.results as Record<string, Stats> | undefined;
  if (!results || typeof results !== "object") return state;
  const kept: Record<string, Stats> = {};
  for (const t of state.targets) {
    const s = cleanStats(results[t.did]);
    if (s) kept[t.did] = s;
  }
  // Series come off the wire, so they are rebuilt through unpackSeries
  // rather than trusted: a peer can put anything in that array.
  const series: Record<string, PackedSample[]> = {};
  const rawSeries = (data.series ?? {}) as Record<string, unknown>;
  for (const t of state.targets) {
    const clean = unpackSeries(rawSeries[t.did]);
    if (clean.length) {
      series[t.did] = clean.map((s) => [s.at, s.rtt] as PackedSample);
    }
  }
  return {
    ...state,
    results: kept,
    series,
    relayed: Array.isArray(data.relayed)
      ? (data.relayed as string[]).filter((d) =>
          state.targets.some((t) => t.did === d)
        )
      : [],
  };
}

export default definePlugin({
  manifest,
  card: PingCard,
  initialState,
  reduce,
  commands: {
    ping: async (args: string, host: HostApi) => {
      const names = parsePingArgs(args);
      if (names.length === 0) {
        console.warn("[ping] format: /ping @alice, @bob, @carol");
        return;
      }
      const online = host.peers();
      const targets: PingTarget[] = [];
      for (const name of names) {
        const match = online.find(
          (p) => p.name.toLowerCase() === name.toLowerCase()
        );
        // Silently pinging somebody who is not here would draw a graph of
        // nothing but loss and look like their connection was the problem.
        if (match) targets.push({ did: match.did, name: match.name });
        else console.warn(`[ping] nobody called ${name} is in this room`);
      }
      if (targets.length === 0) return;
      await host.sendCard({ targets });
    },
  },
});
