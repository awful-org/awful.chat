import {
  match,
  matchExact,
  mergeRanges,
  span,
  type MatchRange,
  type MatchResult,
} from "./scorer";
import type { Mru } from "./mru";
import {
  TIER_EXACT,
  TIER_KEYWORD,
  TIER_PREFIX,
  TIER_SUBTITLE,
  TIER_TITLE,
  type Cmd,
  type ParsedQuery,
  type QueryTerm,
  type RankedCmd,
  type RankedGroup,
} from "./types";

/**
 * How many rows to render at most.
 *
 * Below a few hundred rows a virtualizer buys nothing and makes scroll-into-view,
 * Home/End, paging, and `aria-activedescendant` all harder to get right. Capping
 * the output is the cheaper correct answer.
 */
export const MAX_ROWS = 200;

/** How many recently used commands to surface when the query is empty. */
export const RECENT_ROWS = 5;

export const RECENT_GROUP = "Recently used";

/** Lowercased fields, cached so a multi-term query lowercases each command once. */
interface Lowered {
  title: string;
  subtitle: string | null;
  keywords: string[];
}

const loweredCache = new WeakMap<Cmd, Lowered>();

function lowered(cmd: Cmd): Lowered {
  const cached = loweredCache.get(cmd);
  if (cached) return cached;
  const value: Lowered = {
    title: cmd.title.toLowerCase(),
    subtitle: cmd.subtitle ? cmd.subtitle.toLowerCase() : null,
    keywords: cmd.keywords ? cmd.keywords.map((k) => k.toLowerCase()) : [],
  };
  loweredCache.set(cmd, value);
  return value;
}

/** Where a term matched. Decides which text gets highlighted. */
type Field = "title" | "keyword" | "subtitle";

interface TermHit {
  tier: number;
  score: number;
  field: Field;
  result: MatchResult;
}

/**
 * Match one term against one command, taking the strongest tier available.
 *
 * The order here is the ranking policy: title beats keyword beats subtitle, and
 * an exact or prefix hit on the title beats any fuzzy hit anywhere. Because
 * tiers are spaced `1<<2` apart in score terms, this ordering is absolute.
 */
function matchTerm(low: Lowered, term: QueryTerm): TermHit | null {
  const run = term.exact ? matchExact : match;

  if (!term.exact) {
    // Exact and prefix hits are scored by the same matcher as every other tier,
    // not with a flat number. A multi-term query sums the per-term scores, so a
    // term scored on a different scale would distort the total: "join room"
    // once ranked "Create or join a room" above "Join room by code", because
    // the prefix term contributed a bare length boost while the loser earned a
    // full character score for both of its terms.
    if (low.title === term.text) {
      const hit = match(low.title, term.text);
      if (hit) {
        return { tier: TIER_EXACT, score: hit.score, field: "title", result: hit };
      }
    }

    if (low.title.startsWith(term.text)) {
      const hit = match(low.title, term.text);
      if (hit) {
        // Shorter titles win a prefix tie: given "Room" and "Room settings" for
        // the query "room", the bare "Room" is what was meant.
        const boost = Math.round((term.text.length / low.title.length) * 100);
        const score = hit.score + boost;
        return {
          tier: TIER_PREFIX,
          score,
          field: "title",
          result: { score, positions: hit.positions },
        };
      }
    }
  }

  const onTitle = run(low.title, term.text);
  if (onTitle) {
    return {
      tier: TIER_TITLE,
      score: onTitle.score,
      field: "title",
      result: onTitle,
    };
  }

  // Keywords are aliases. They rank the row but are never highlighted, because
  // they are not on screen.
  let bestKeyword: MatchResult | null = null;
  for (const keyword of low.keywords) {
    const hit = run(keyword, term.text);
    if (hit && (!bestKeyword || hit.score > bestKeyword.score)) bestKeyword = hit;
  }
  if (bestKeyword) {
    return {
      tier: TIER_KEYWORD,
      score: bestKeyword.score,
      field: "keyword",
      result: bestKeyword,
    };
  }

  if (low.subtitle !== null) {
    const onSubtitle = run(low.subtitle, term.text);
    if (onSubtitle) {
      return {
        tier: TIER_SUBTITLE,
        score: onSubtitle.score,
        field: "subtitle",
        result: onSubtitle,
      };
    }
  }

  return null;
}

/**
 * Score one command against every term.
 *
 * Every term must match something, so typing more words always narrows. The
 * command takes its *weakest* term's tier, which stops one strong title hit from
 * dragging a row up when the rest of the query only grazed its subtitle.
 *
 * @returns The ranked row, or `null` when any term failed to match.
 */
export function scoreCmd(cmd: Cmd, terms: readonly QueryTerm[]): RankedCmd | null {
  if (terms.length === 0) {
    return {
      cmd,
      score: 0,
      tier: TIER_EXACT,
      titleRanges: [],
      subtitleRanges: [],
      titleSpan: 0,
    };
  }

  const low = lowered(cmd);
  let weakestTier = Number.POSITIVE_INFINITY;
  let total = 0;
  const titleRanges: MatchRange[] = [];
  const subtitleRanges: MatchRange[] = [];
  const titlePositions: number[] = [];

  for (const term of terms) {
    const hit = matchTerm(low, term);
    if (!hit) return null;

    weakestTier = Math.min(weakestTier, hit.tier);
    total += hit.score;

    if (hit.field === "title") {
      titlePositions.push(...hit.result.positions);
      for (const p of hit.result.positions) {
        titleRanges.push({ start: p, end: p + 1 });
      }
    } else if (hit.field === "subtitle") {
      for (const p of hit.result.positions) {
        subtitleRanges.push({ start: p, end: p + 1 });
      }
    }
  }

  titlePositions.sort((a, b) => a - b);
  return {
    cmd,
    score: weakestTier + total,
    tier: weakestTier,
    titleRanges: mergeRanges(titleRanges),
    subtitleRanges: mergeRanges(subtitleRanges),
    titleSpan: span(titlePositions),
  };
}

/**
 * Order two rows.
 *
 * An ordered tuple, never a weighted sum, and it never returns 0 before the last
 * rule. Every tie left unbroken shows up as rows swapping places between
 * keystrokes, which reads as the palette being unstable.
 *
 * Recency sits *inside* a relevance class, not above it, so a recently used
 * command can outrank an equally relevant one but never a better match.
 */
export function compareRanked(
  a: RankedCmd,
  b: RankedCmd,
  mru: Mru,
  seq: ReadonlyMap<string, number>,
): number {
  if (a.tier !== b.tier) return b.tier - a.tier;

  const rankA = mru.rank(a.cmd.id);
  const rankB = mru.rank(b.cmd.id);
  if (rankA !== undefined && rankB !== undefined && rankA !== rankB) {
    return rankB - rankA;
  }
  if (rankA !== undefined && rankB === undefined) return -1;
  if (rankB !== undefined && rankA === undefined) return 1;

  if (a.score !== b.score) return b.score - a.score;

  // A tighter match is a better one, except under a prefix hit, where a longer
  // match means more of the title was typed.
  if (a.tier < TIER_PREFIX && a.titleSpan !== b.titleSpan) {
    return a.titleSpan - b.titleSpan;
  }

  if (a.cmd.title.length !== b.cmd.title.length) {
    return a.cmd.title.length - b.cmd.title.length;
  }

  const byTitle = a.cmd.title.localeCompare(b.cmd.title);
  if (byTitle !== 0) return byTitle;

  // Authored order, so the result is fully deterministic.
  return (seq.get(a.cmd.id) ?? 0) - (seq.get(b.cmd.id) ?? 0);
}

/**
 * Two rows sharing a title are indistinguishable to the user. Rooms collide by
 * name routinely. Mark the collisions so the row can show the id alongside.
 */
function disambiguate(rows: RankedCmd[]): void {
  const seen = new Map<string, RankedCmd[]>();
  for (const row of rows) {
    const key = row.cmd.title.toLowerCase();
    const bucket = seen.get(key);
    if (bucket) bucket.push(row);
    else seen.set(key, [row]);
  }
  for (const bucket of seen.values()) {
    if (bucket.length < 2) continue;
    for (const row of bucket) {
      if (row.cmd.subtitle) continue;
      row.cmd = { ...row.cmd, subtitle: row.cmd.id };
    }
  }
}

/**
 * Filter, order, and group commands for display.
 *
 * With no query the catalog is shown in authored order, led by a recently used
 * group. With a query the rows are ranked and the groups follow their best
 * member, which is what makes the top row feel chosen rather than stumbled on.
 */
export function rank(
  cmds: readonly Cmd[],
  query: ParsedQuery,
  mru: Mru,
  limit = MAX_ROWS,
): RankedGroup[] {
  const seq = new Map<string, number>();
  cmds.forEach((cmd, index) => seq.set(cmd.id, index));

  if (query.terms.length === 0) {
    return groupUnfiltered(cmds, mru, limit);
  }

  const rows: RankedCmd[] = [];
  for (const cmd of cmds) {
    const scored = scoreCmd(cmd, query.terms);
    if (scored) rows.push(scored);
  }

  rows.sort((a, b) => compareRanked(a, b, mru, seq));
  const visible = rows.slice(0, limit);
  disambiguate(visible);

  // Group score is its best member's score, and members keep their global order
  // within the group.
  const groups = new Map<string, RankedCmd[]>();
  for (const row of visible) {
    const bucket = groups.get(row.cmd.group);
    if (bucket) bucket.push(row);
    else groups.set(row.cmd.group, [row]);
  }

  return [...groups.entries()]
    .map(([name, items]) => ({ name, items }))
    .sort((a, b) => b.items[0].score - a.items[0].score);
}

/** The empty-query view: recents first, then the catalog in authored order. */
function groupUnfiltered(
  cmds: readonly Cmd[],
  mru: Mru,
  limit: number,
): RankedGroup[] {
  const byId = new Map(cmds.map((cmd) => [cmd.id, cmd]));
  const recentIds = mru.recent(RECENT_ROWS).filter((id) => byId.has(id));
  const recentSet = new Set(recentIds);

  const out: RankedGroup[] = [];
  let remaining = limit;

  if (recentIds.length > 0) {
    const items = recentIds
      .slice(0, remaining)
      .map((id) => blankRow(byId.get(id)!));
    remaining -= items.length;
    out.push({ name: RECENT_GROUP, items });
  }

  const groups = new Map<string, RankedCmd[]>();
  for (const cmd of cmds) {
    if (remaining <= 0) break;
    // A recent row is already on screen; showing it twice wastes a slot and
    // breaks the "one row per id" invariant that keying depends on.
    if (recentSet.has(cmd.id)) continue;
    const bucket = groups.get(cmd.group);
    if (bucket) bucket.push(blankRow(cmd));
    else groups.set(cmd.group, [blankRow(cmd)]);
    remaining--;
  }

  for (const [name, items] of groups) out.push({ name, items });
  return out;
}

function blankRow(cmd: Cmd): RankedCmd {
  return {
    cmd,
    score: 0,
    tier: TIER_EXACT,
    titleRanges: [],
    subtitleRanges: [],
    titleSpan: 0,
  };
}

/** Flatten groups into the row order the keyboard walks. */
export function flatten(groups: readonly RankedGroup[]): RankedCmd[] {
  const out: RankedCmd[] = [];
  for (const group of groups) out.push(...group.items);
  return out;
}
