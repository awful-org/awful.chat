/** The one-line label a call tile gives a person ("Playing Jeopardy"). */

/** Room for "Playing" and a game's name in a sidebar row. */
export const MAX_ACTIVITY = 48;

const segmenter =
  typeof Intl !== "undefined" && "Segmenter" in Intl
    ? new Intl.Segmenter(undefined, { granularity: "grapheme" })
    : null;

/** What a person counts as characters: one emoji is one, whatever it is made of. */
function characters(text: string): string[] {
  return segmenter ? Array.from(segmenter.segment(text), (s) => s.segment) : [...text];
}

/**
 * One line of plain text, or null. Plugins pass along what third parties
 * say, so: no control or formatting characters, whitespace collapsed,
 * bounded. The zero-width joiner is the one formatting character kept: it
 * only glues emoji together (👩‍💻), and a space there splits them apart.
 */
export function cleanActivity(label: unknown, max = MAX_ACTIVITY): string | null {
  if (typeof label !== "string") return null;
  const clean = label
    .replace(/(?!\u200D)[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
  return clean ? characters(clean).slice(0, max).join("").trim() || null : null;
}
