/**
 * Fuzzy matcher for the command palette.
 *
 * This is a port of fzf's `FuzzyMatchV2` (Smith-Waterman with affine gap
 * penalties) from `src/algo/algo.go`. It returns a score AND the matched
 * character positions, so rows can highlight the characters the user typed.
 *
 * Why not the cmdk / bits-ui scorer:
 *   1. It returns a score only. You cannot highlight from it.
 *   2. It has no length cap. A 300-character label costs ~29 ms per call,
 *      which drops frames on one keystroke. This DP caps at MAX_TEXT and
 *      prefilters, so its cost is bounded by construction.
 *
 * The bonus constants are fzf's, and they are calibrated rather than guessed:
 * BONUS_BOUNDARY (8) against GAP_EXTENSION (-1) means an acronym jump pays for
 * itself across about 8 characters, which is the average English word length.
 * Do not tune one constant without re-reading that relationship.
 *
 * Case handling: matching is case-insensitive and case agreement earns no
 * bonus. Tiering in `rank.ts` does the heavy lifting for intent, so a case
 * bonus here would only add noise.
 */

/** Inclusive-start, exclusive-end slice of a string, for highlighting. */
export interface MatchRange {
  start: number;
  end: number;
}

export interface MatchResult {
  /** Higher is better. Only comparable between candidates for the same term. */
  score: number;
  /** Matched indices into the target text, ascending. */
  positions: number[];
}

// Character classes. The numeric order matters: `cls > CLS_NONWORD` is the
// test fzf uses for "this character starts a word".
const CLS_WHITE = 0;
const CLS_NONWORD = 1;
const CLS_DELIMITER = 2;
const CLS_LOWER = 3;
const CLS_UPPER = 4;
const CLS_LETTER = 5;
const CLS_NUMBER = 6;

// fzf's score table (algo.go:113-153).
const SCORE_MATCH = 16;
const SCORE_GAP_START = -3;
const SCORE_GAP_EXTENSION = -1;
const BONUS_BOUNDARY = SCORE_MATCH / 2; // 8
const BONUS_NONWORD = SCORE_MATCH / 2; // 8
const BONUS_CAMEL = BONUS_BOUNDARY + SCORE_GAP_EXTENSION; // 7
const BONUS_CONSECUTIVE = -(SCORE_GAP_START + SCORE_GAP_EXTENSION); // 4
const BONUS_FIRST_CHAR_MULTIPLIER = 2;
const BONUS_BOUNDARY_WHITE = BONUS_BOUNDARY + 2; // 10
const BONUS_BOUNDARY_DELIMITER = BONUS_BOUNDARY + 1; // 9

/**
 * Hard caps. These exist to make the worst case cheap, not to be generous.
 * A palette row nobody can read is not worth scoring past 256 characters.
 */
export const MAX_TEXT = 256;
export const MAX_PATTERN = 64;

const CODE_0 = 48;
const CODE_9 = 57;
const CODE_A_UPPER = 65;
const CODE_Z_UPPER = 90;
const CODE_A_LOWER = 97;
const CODE_Z_LOWER = 122;

/** fzf's `delimiterChars`, plus the separators our labels actually contain. */
const DELIMITERS = "/,:;|-_.";

function classOf(code: number): number {
  if (code >= CODE_A_LOWER && code <= CODE_Z_LOWER) return CLS_LOWER;
  if (code >= CODE_A_UPPER && code <= CODE_Z_UPPER) return CLS_UPPER;
  if (code >= CODE_0 && code <= CODE_9) return CLS_NUMBER;
  // Space, tab, newline, vertical tab, form feed, carriage return, NBSP.
  if (
    code === 32 ||
    code === 9 ||
    code === 10 ||
    code === 11 ||
    code === 12 ||
    code === 13 ||
    code === 0x85 ||
    code === 0xa0
  ) {
    return CLS_WHITE;
  }
  if (code < 128) {
    return DELIMITERS.includes(String.fromCharCode(code))
      ? CLS_DELIMITER
      : CLS_NONWORD;
  }
  // Non-ASCII. Treat letters and digits as word characters so that accented
  // nicknames and non-Latin room names still match, and everything else as a
  // non-word boundary.
  const ch = String.fromCharCode(code);
  if (/\p{L}/u.test(ch)) return CLS_LETTER;
  if (/\p{N}/u.test(ch)) return CLS_NUMBER;
  if (/\s/u.test(ch)) return CLS_WHITE;
  return CLS_NONWORD;
}

/**
 * How much a match at a position is worth, given what precedes it.
 * Ported verbatim from fzf `bonusFor` (algo.go:298-320).
 */
function bonusFor(prevClass: number, cls: number): number {
  if (cls > CLS_NONWORD) {
    if (prevClass === CLS_WHITE) return BONUS_BOUNDARY_WHITE;
    if (prevClass === CLS_DELIMITER) return BONUS_BOUNDARY_DELIMITER;
    if (prevClass === CLS_NONWORD) return BONUS_BOUNDARY;
  }
  // camelCase, and letter-to-digit as in "room2".
  if (
    (prevClass === CLS_LOWER && cls === CLS_UPPER) ||
    (prevClass !== CLS_NUMBER && cls === CLS_NUMBER)
  ) {
    return BONUS_CAMEL;
  }
  if (cls === CLS_NONWORD || cls === CLS_DELIMITER) return BONUS_NONWORD;
  if (cls === CLS_WHITE) return BONUS_BOUNDARY_WHITE;
  return 0;
}

// Module-level scratch buffers. The matcher runs once per candidate per term on
// every keystroke, so it must not allocate. Sized for the caps above:
// MAX_PATTERN * MAX_TEXT = 16384 cells, 32 KB per Int16Array.
const bonus = new Int16Array(MAX_TEXT);
const h0 = new Int16Array(MAX_TEXT);
const c0 = new Int16Array(MAX_TEXT);
const firstOccurrence = new Int32Array(MAX_PATTERN);
const matrixH = new Int16Array(MAX_PATTERN * MAX_TEXT);
const matrixC = new Int16Array(MAX_PATTERN * MAX_TEXT);

/**
 * Cheap in-order prefilter. Returns the index of the first character that could
 * begin a match, or -1 when the pattern is not present in order at all.
 * This rejects the large majority of candidates before the DP runs.
 */
function fuzzyIndex(lowText: string, lowPattern: string, n: number): number {
  let first = -1;
  let from = 0;
  for (let p = 0; p < lowPattern.length; p++) {
    const at = lowText.indexOf(lowPattern[p], from);
    if (at < 0 || at >= n) return -1;
    if (p === 0) first = at;
    from = at + 1;
  }
  return first;
}

/**
 * Match `lowPattern` against `lowText`.
 *
 * Both arguments MUST already be lowercased by the caller. Lowercasing here
 * would dominate the cost, which is the mistake cmdk's scorer documents.
 *
 * @returns The score and matched positions, or `null` when there is no match.
 */
export function match(lowText: string, lowPattern: string): MatchResult | null {
  const m = lowPattern.length;
  if (m === 0) return null;
  if (m > MAX_PATTERN) return null;

  const n = Math.min(lowText.length, MAX_TEXT);
  if (m > n) return null;

  const start = fuzzyIndex(lowText, lowPattern, n);
  if (start < 0) return null;

  // Phase 1+2: per-position bonuses and the first matrix row, computed in one
  // pass. Also records where each pattern character first appears, which bounds
  // the columns the remaining rows have to visit.
  const pChar0 = lowPattern[0];
  let pIdx = 0;
  let pChar = lowPattern[0];
  let lastIdx = start;
  let prevH0 = 0;
  // fzf seeds this with whitespace because its DP starts at the prefilter
  // index, which silently grants a word-boundary bonus to whatever character
  // happens to sit there: "Battery" would score `t` as highly as "Set Theme".
  // Read the real preceding character instead. This is a deliberate
  // improvement on the original, and it leaves matches that genuinely start at
  // a boundary unchanged.
  let prevClass =
    start === 0 ? CLS_WHITE : classOf(lowText.charCodeAt(start - 1));
  let inGap = false;
  let maxScore = 0;
  let maxScorePos = start;

  for (let i = start; i < n; i++) {
    const ch = lowText[i];
    const cls = classOf(lowText.charCodeAt(i));
    const b = bonusFor(prevClass, cls);
    bonus[i] = b;
    prevClass = cls;

    if (ch === pChar) {
      if (pIdx < m) {
        firstOccurrence[pIdx] = i;
        pIdx++;
        pChar = lowPattern[Math.min(pIdx, m - 1)];
      }
      lastIdx = i;
    }

    if (ch === pChar0) {
      const score = SCORE_MATCH + b * BONUS_FIRST_CHAR_MULTIPLIER;
      h0[i] = score;
      c0[i] = 1;
      if (m === 1 && score > maxScore) {
        maxScore = score;
        maxScorePos = i;
        // A word-boundary hit on a one-character pattern cannot be beaten.
        if (b >= BONUS_BOUNDARY) break;
      }
      inGap = false;
    } else {
      // Affine gap: opening costs more than extending, so one long skip is
      // cheaper than several short ones.
      const penalty = inGap ? SCORE_GAP_EXTENSION : SCORE_GAP_START;
      h0[i] = Math.max(prevH0 + penalty, 0);
      c0[i] = 0;
      inGap = true;
    }
    prevH0 = h0[i];
  }

  if (pIdx !== m) return null;

  if (m === 1) {
    return { score: maxScore, positions: [maxScorePos] };
  }

  // Phase 3: the remaining rows, restricted to columns [firstOccurrence[row], lastIdx].
  const f0 = firstOccurrence[0];
  const width = lastIdx - f0 + 1;

  for (let col = f0; col <= lastIdx; col++) {
    matrixH[col - f0] = h0[col];
    matrixC[col - f0] = c0[col];
  }

  for (let row = 1; row < m; row++) {
    const rowStart = row * width;
    const f = firstOccurrence[row];
    const rowChar = lowPattern[row];
    inGap = false;
    // fzf zeroes the cell immediately left of the row's first column so the
    // "come from the left" branch cannot read a stale value.
    if (f - f0 - 1 >= 0) matrixH[rowStart + f - f0 - 1] = 0;

    for (let col = f; col <= lastIdx; col++) {
      const offset = rowStart + col - f0;
      const diagOffset = offset - width - 1;

      // Skip this target character. The annotation is load-bearing: `inGap` is
      // assigned from `s2` at the bottom of this loop, so without it TypeScript
      // chases the back edge and reports a circular inference.
      const left = col > f ? matrixH[offset - 1] : 0;
      const s2: number = left + (inGap ? SCORE_GAP_EXTENSION : SCORE_GAP_START);

      let s1 = 0;
      let consecutive = 0;
      if (rowChar === lowText[col]) {
        s1 = matrixH[diagOffset] + SCORE_MATCH;
        let b = bonus[col];
        consecutive = matrixC[diagOffset] + 1;
        if (consecutive > 1) {
          const firstBonus = bonus[col - consecutive + 1];
          // A strong boundary in the middle of a run starts a new run instead
          // of extending the old one, so "myRoom" on "room" credits the
          // boundary rather than a 4-char run from the wrong place.
          if (b >= BONUS_BOUNDARY && b > firstBonus) {
            consecutive = 1;
          } else {
            // The run bonus does not stack with the boundary bonus.
            b = Math.max(b, Math.max(BONUS_CONSECUTIVE, firstBonus));
          }
        }
        if (s1 + b < s2) {
          s1 += bonus[col];
          consecutive = 0;
        } else {
          s1 += b;
        }
      }

      matrixC[offset] = consecutive;
      inGap = s1 < s2;
      const score = Math.max(s1, s2, 0);
      if (row === m - 1 && score > maxScore) {
        maxScore = score;
        maxScorePos = col;
      }
      matrixH[offset] = score;
    }
  }

  // Phase 4: backtrace for the matched positions. A forward-greedy walk picks
  // visibly wrong characters, so preferMatch carries run state backwards.
  const positions: number[] = [];
  let row = m - 1;
  let col = maxScorePos;
  let preferMatch = true;
  for (;;) {
    const rowStart = row * width;
    const offset = rowStart + col - f0;
    const here = matrixH[offset];

    const diag =
      row > 0 && col >= firstOccurrence[row] ? matrixH[offset - width - 1] : 0;
    const left = col > firstOccurrence[row] ? matrixH[offset - 1] : 0;

    if (here > diag && (here > left || (here === left && preferMatch))) {
      positions.push(col);
      if (row === 0) break;
      row--;
    }
    const below = offset + width + 1;
    preferMatch =
      matrixC[offset] > 1 || (below < matrixC.length && matrixC[below] > 0);
    col--;
    if (col < f0) break;
  }

  positions.reverse();
  return { score: maxScore, positions };
}

/**
 * Collapse ascending positions into contiguous ranges for rendering.
 * `[0, 1, 2, 7]` becomes `[{0,3}, {7,8}]`.
 */
export function toRanges(positions: readonly number[]): MatchRange[] {
  const out: MatchRange[] = [];
  for (const p of positions) {
    const last = out[out.length - 1];
    if (last && last.end === p) last.end = p + 1;
    else out.push({ start: p, end: p + 1 });
  }
  return out;
}

/**
 * Merge overlapping or touching ranges from several terms into one ascending,
 * non-overlapping list. Needed because a multi-term query produces one range
 * set per term against the same text.
 */
export function mergeRanges(ranges: readonly MatchRange[]): MatchRange[] {
  if (ranges.length < 2) return ranges.slice();
  const sorted = ranges.slice().sort((a, b) => a.start - b.start);
  const out: MatchRange[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1];
    const cur = sorted[i];
    if (cur.start <= prev.end) prev.end = Math.max(prev.end, cur.end);
    else out.push({ ...cur });
  }
  return out;
}

/** Total span the match covers. Used as a tie-break: tighter matches win. */
export function span(positions: readonly number[]): number {
  if (positions.length === 0) return 0;
  return positions[positions.length - 1] - positions[0] + 1;
}

/**
 * Contiguous case-insensitive substring match, for quoted queries.
 * Returns the same shape as `match` so callers can treat them alike.
 */
export function matchExact(
  lowText: string,
  lowPattern: string,
): MatchResult | null {
  if (lowPattern.length === 0) return null;
  const at = lowText.indexOf(lowPattern);
  if (at < 0) return null;
  const positions: number[] = [];
  for (let i = 0; i < lowPattern.length; i++) positions.push(at + i);
  // Score it like a run of matches so it stays comparable with fuzzy scores.
  const base = SCORE_MATCH * lowPattern.length;
  const boundary = at === 0 ? BONUS_BOUNDARY_WHITE * BONUS_FIRST_CHAR_MULTIPLIER : 0;
  return { score: base + boundary, positions };
}
