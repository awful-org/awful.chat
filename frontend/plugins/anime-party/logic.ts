/**
 * Pure state and reducer for one anime watch party, separated from Svelte
 * so tests exercise the real fold.
 *
 * Durable card state carries what the party's history needs to survive a
 * reload: who owns it, what is selected, whether it is paused, who is in
 * it. It deliberately does NOT carry a live position - a bare position
 * ages the instant it is written (see the ecosystem's own watch-together
 * plugin, whose flat `position: number` cannot stay correct). Position
 * only ever travels as a `WatchTick` - a timestamp and a rate, never a
 * bare number - either folded live as an EPHEMERAL update (the routine
 * heartbeat) or carried once inside a `resync-response` (the late-joiner
 * round trip). `$lib/plugins/watch` owns what a client DOES with a tick;
 * this module only validates the shape peers put on the wire.
 */
import type { UpdateCtx } from "$lib/plugins/api";
import type { WatchTick } from "$lib/plugins/watch";
import { ANILIST_COVER_HOST_RE } from "./anilist";

export interface AnimePartyState {
  ownerDid: string;
  title: string;
  anilistId: number | null;
  coverImageUrl: string | null;
  episode: number;
  episodeCount: number | null;
  paused: boolean;
  closed: boolean;
  /** did -> display name. Insertion order is fold order, so every client
   *  agrees on who the longest-standing non-owner member is (the one
   *  allowed to declare the host gone - see `reduce`'s "host-left"). */
  members: Map<string, string>;
  syncRequest?: { id: string; requesterDid: string };
  syncResponse?: { id: string; targetDid: string; tick: WatchTick };
  /** The owner's most recent tick. EPHEMERAL-folded only: never persisted,
   *  never replayed, so a cold load starts with this null until the owner
   *  sends the next heartbeat - exactly like a viewer who was never sent
   *  one of ping's samples. */
  lastTick: WatchTick | null;
}

const MAX_TITLE_LEN = 200;

function clampTitle(value: unknown): string {
  if (typeof value !== "string") return "Untitled anime";
  const trimmed = value.trim().slice(0, MAX_TITLE_LEN);
  return trimmed || "Untitled anime";
}

function validCoverUrl(value: unknown): string | null {
  return typeof value === "string" && ANILIST_COVER_HOST_RE.test(value) ? value : null;
}

function validEpisodeCount(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

function validAnilistId(value: unknown): number | null {
  return typeof value === "number" && Number.isInteger(value) && value > 0 ? value : null;
}

/** Structural check on a peer-supplied tick. `rate` is capped at 4x: the
 *  control law only ever asks for a small catch-up nudge, so anything past
 *  that is a forged or nonsensical value, not a real playback rate. */
function validTick(value: unknown): WatchTick | null {
  if (!value || typeof value !== "object") return null;
  const v = value as Record<string, unknown>;
  if (typeof v.paused !== "boolean") return null;
  if (typeof v.position !== "number" || !Number.isFinite(v.position) || v.position < 0)
    return null;
  if (typeof v.atMs !== "number" || !Number.isFinite(v.atMs) || v.atMs <= 0) return null;
  if (typeof v.rate !== "number" || !Number.isFinite(v.rate) || v.rate <= 0 || v.rate > 4)
    return null;
  if (typeof v.seq !== "number" || !Number.isInteger(v.seq) || v.seq < 0) return null;
  return { paused: v.paused, position: v.position, atMs: v.atMs, rate: v.rate, seq: v.seq };
}

export function initialState(cardData: unknown): AnimePartyState {
  const data = cardData as Record<string, unknown> | null | undefined;
  // Peer-supplied and possibly forged (any room member can call
  // host.sendCard): an absent or empty ownerDid is not a party with no
  // host, it is a party nobody can be shown to own, so it is born closed -
  // the reducer's first line then turns every action into a no-op rather
  // than every case having to remember to check.
  const ownerDid =
    typeof data?.ownerDid === "string" && data.ownerDid !== "" ? data.ownerDid : "";
  return {
    ownerDid,
    title: clampTitle(data?.title),
    anilistId: validAnilistId(data?.anilistId),
    coverImageUrl: validCoverUrl(data?.coverImageUrl),
    episode: 1,
    episodeCount: validEpisodeCount(data?.episodeCount),
    paused: true,
    closed: ownerDid === "",
    members: new Map(ownerDid ? [[ownerDid, "Host"]] : []),
    lastTick: null,
  };
}

export function reduce(
  state: unknown,
  update: { data: unknown },
  ctx: UpdateCtx
): AnimePartyState {
  const party = state as AnimePartyState;
  const data = update.data as Record<string, unknown>;
  if (typeof data !== "object" || data === null) return party;
  if (party.closed) return party;

  if (ctx.ephemeral) {
    if (data.action !== "tick" || ctx.senderDid !== party.ownerDid) return party;
    const tick = validTick(data.tick);
    // seq guards against network reordering: ephemeral updates are live-only
    // and unordered by design, so without this an out-of-order heartbeat
    // could roll the shown position backwards.
    if (!tick || (party.lastTick && tick.seq <= party.lastTick.seq)) return party;
    return { ...party, lastTick: tick };
  }

  switch (data.action) {
    case "join": {
      if (party.members.has(ctx.senderDid)) return party;
      const members = new Map(party.members);
      members.set(ctx.senderDid, ctx.senderName);
      return { ...party, members };
    }
    case "leave": {
      if (!party.members.has(ctx.senderDid) || ctx.senderDid === party.ownerDid) return party;
      const members = new Map(party.members);
      members.delete(ctx.senderDid);
      return { ...party, members };
    }
    case "close":
      return ctx.senderDid !== party.ownerDid ? party : { ...party, closed: true, paused: true };
    // Fired by whichever non-owner member observed the host's grace window
    // elapse (see host-departure.ts). Every member may attempt it; only the
    // longest-standing non-owner member's attempt is honoured, so the
    // outcome is the same on every client regardless of who is still
    // running a timer for it.
    case "host-left": {
      const observers = [...party.members.keys()].filter((did) => did !== party.ownerDid);
      return observers[0] !== ctx.senderDid
        ? party
        : { ...party, closed: true, paused: true };
    }
    case "select-episode": {
      if (ctx.senderDid !== party.ownerDid) return party;
      const episode = data.episode;
      if (typeof episode !== "number" || !Number.isInteger(episode) || episode < 1)
        return party;
      if (party.episodeCount !== null && episode > party.episodeCount) return party;
      if (episode === party.episode) return party;
      // A new episode is a new file for every participant: nothing carries
      // forward from the last one's playback.
      return { ...party, episode, paused: true, lastTick: null };
    }
    case "play":
      return ctx.senderDid !== party.ownerDid || !party.paused
        ? party
        : { ...party, paused: false };
    case "pause":
      return ctx.senderDid !== party.ownerDid || party.paused
        ? party
        : { ...party, paused: true };
    case "resync-request": {
      if (!party.members.has(ctx.senderDid)) return party;
      const requestId = data.requestId;
      if (typeof requestId !== "string" || requestId.length < 8 || requestId.length > 128)
        return party;
      return { ...party, syncRequest: { id: requestId, requesterDid: ctx.senderDid } };
    }
    case "resync-response": {
      if (ctx.senderDid !== party.ownerDid) return party;
      const targetDid = data.targetDid;
      const requestId = data.requestId;
      const tick = validTick(data.tick);
      if (typeof targetDid !== "string" || typeof requestId !== "string" || !tick)
        return party;
      return {
        ...party,
        syncRequest: party.syncRequest?.id === requestId ? undefined : party.syncRequest,
        syncResponse: { targetDid, id: requestId, tick },
        lastTick: tick,
      };
    }
    default:
      return party;
  }
}
