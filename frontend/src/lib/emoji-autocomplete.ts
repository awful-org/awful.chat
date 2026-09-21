import type Database from "emoji-picker-element/database";

export interface EmojiSuggestion { unicode: string; shortcode: string }
export interface EmojiToken { start: number; end: number; query: string; closed: boolean }

/** Only a standalone shortcode at the caret, never a URL, time, or code span. */
export function emojiToken(text: string, caret: number, selectionEnd = caret): EmojiToken | null {
  if (caret !== selectionEnd) return null;
  const before = text.slice(0, caret);
  if ((before.match(/`/g)?.length ?? 0) % 2 !== 0) return null;
  const match = /(?:^|[\s([{])(:([a-z0-9_+-]{0,40})(:)?$)/i.exec(before);
  if (!match || (match[3] && !match[2])) return null;
  return { start: caret - match[1].length, end: caret, query: match[2].toLowerCase(), closed: !!match[3] };
}

export function insertEmoji(text: string, token: EmojiToken, unicode: string) {
  return {
    value: text.slice(0, token.start) + unicode + text.slice(token.end),
    caret: token.start + unicode.length,
  };
}

// Instant suggestions for ':' and a small offline fallback before the picker
// database has ever downloaded. Full search shares the existing picker's DB.
const COMMON: EmojiSuggestion[] = [
  ["😀", "grinning"], ["😄", "smile"], ["😂", "joy"], ["😊", "blush"],
  ["❤️", "heart"], ["👍", "thumbsup"], ["👎", "thumbsdown"], ["🔥", "fire"],
  ["🎉", "tada"], ["👀", "eyes"], ["😭", "sob"], ["💀", "skull"],
  ["🤔", "thinking"], ["😎", "sunglasses"], ["✅", "white_check_mark"],
  ["🙏", "pray"], ["👋", "wave"], ["🚀", "rocket"], ["💯", "100"],
  ["😅", "sweat_smile"], ["🥰", "smiling_face_with_three_hearts"],
  ["🤣", "rofl"], ["🤷", "shrug"], ["✨", "sparkles"],
].map(([unicode, shortcode]) => ({ unicode, shortcode }));

let database: Promise<Database> | null = null;
function getDatabase() {
  return database ??= import("emoji-picker-element/database").then(({ default: Database }) => new Database());
}

export function commonEmoji(query: string): EmojiSuggestion[] {
  return COMMON.filter((emoji) => emoji.shortcode.includes(query)).slice(0, 8);
}

export async function searchEmoji(query: string): Promise<EmojiSuggestion[]> {
  if (!query) return commonEmoji("");
  try {
    const db = await getDatabase();
    const [exact, matches, skinTone] = await Promise.all([
      db.getEmojiByShortcode(query),
      db.getEmojiBySearchQuery(query.replace(/[_-]/g, " ")),
      db.getPreferredSkinTone(),
    ]);
    const seen = new Set<string>();
    const results: EmojiSuggestion[] = [];
    for (const emoji of [...(exact ? [exact] : []), ...matches]) {
      if (!("unicode" in emoji) || seen.has(emoji.unicode)) continue;
      seen.add(emoji.unicode);
      const shortcode = emoji.shortcodes?.find((code) => code === query) ??
        emoji.shortcodes?.find((code) => code.startsWith(query)) ??
        emoji.shortcodes?.[0] ?? emoji.annotation.replace(/\s+/g, "_");
      results.push({
        unicode: emoji.skins?.find((skin) => skin.tone === skinTone)?.unicode ?? emoji.unicode,
        shortcode,
      });
      if (results.length === 8) break;
    }
    return results.length ? results : commonEmoji(query);
  } catch {
    database = null;
    return commonEmoji(query);
  }
}
