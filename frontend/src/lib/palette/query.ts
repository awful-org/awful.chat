import { normalizeRoomCode } from "$lib/room-code";
import { SIGILS, type ParsedQuery, type QueryTerm, type Sigil } from "./types";

/**
 * Parse what the user typed into a scope and a list of terms.
 *
 * Rules, all borrowed from VS Code's quick access:
 *   - A leading sigil scopes the search and is stripped from the terms.
 *   - Whitespace splits the rest into terms, and every term must match. Typing
 *     more words narrows; it never widens.
 *   - A quoted segment must match contiguously, which is the escape hatch when
 *     fuzzy matching is too eager.
 */
export function parseQuery(raw: string): ParsedQuery {
  let sigil: Sigil | null = null;
  let rest = raw;

  const head = raw[0];
  if (head !== undefined && head in SIGILS) {
    sigil = head as Sigil;
    rest = raw.slice(1);
  }

  const body = rest.trim();
  return { raw, sigil, body, terms: splitTerms(body) };
}

/**
 * Split a query body into terms, honouring double quotes.
 *
 * An unclosed quote is treated as if it closed at the end of the string, so the
 * query stays usable while the user is still typing it.
 */
function splitTerms(body: string): QueryTerm[] {
  const terms: QueryTerm[] = [];
  let i = 0;

  while (i < body.length) {
    if (/\s/.test(body[i])) {
      i++;
      continue;
    }

    if (body[i] === '"') {
      const close = body.indexOf('"', i + 1);
      const end = close < 0 ? body.length : close;
      const text = body.slice(i + 1, end).trim().toLowerCase();
      if (text.length > 0) terms.push({ text, exact: true });
      i = close < 0 ? body.length : close + 1;
      continue;
    }

    let end = i;
    while (end < body.length && !/\s/.test(body[end]) && body[end] !== '"') end++;
    const text = body.slice(i, end).toLowerCase();
    if (text.length > 0) terms.push({ text, exact: false });
    i = end;
  }

  return terms;
}

/**
 * Every shape a room code has ever had: 13 chars of Crockford base32 today,
 * 16 hex chars from 2026-08-28, 6 hex chars before that. Older rooms keep
 * their code for life (see room-code.ts), so all three must still parse.
 */
const HEX_ROOM_CODE = /^(?:[0-9a-f]{6}|[0-9a-f]{16})$/;
const BASE32_ROOM_CODE = /^[0-9A-HJKMNP-TV-Z]{13}$/;

/**
 * Pull a room code out of whatever the user pasted.
 *
 * Accepts a bare code, a full invite URL, or a `web+awfl://` link, because all
 * three are things a user will paste into the palette. Mirrors the split that
 * `RoomCreateJoin` already does on its paste handler.
 *
 * Invite links carry the code in the FRAGMENT now (`/r/#<code>`), so the
 * leading `#` has to come off before the split below - that split treats `#`
 * as a terminator and would otherwise cut the whole code away. Path-form
 * links keep working.
 *
 * @returns The lowercase room code, or `null` when the text is not one.
 */
export function parseRoomCode(text: string): string | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return null;

  const candidates = [trimmed];
  const afterPath = trimmed.split("/r/")[1];
  if (afterPath !== undefined) candidates.push(afterPath.replace(/^#/, ""));
  const afterProtocol = trimmed.split("web+awfl://")[1];
  if (afterProtocol !== undefined) candidates.push(afterProtocol);

  for (const candidate of candidates) {
    // Drop any trailing path, query, or fragment left on a pasted URL.
    const raw = candidate.split(/[/?#]/)[0].trim();
    // normalizeRoomCode folds separators and look-alikes only for a base32
    // code and returns anything else trimmed, so legacy hex is untouched.
    const folded = normalizeRoomCode(raw);
    if (BASE32_ROOM_CODE.test(folded)) return folded;
    const hex = raw.toLowerCase();
    if (HEX_ROOM_CODE.test(hex)) return hex;
  }
  return null;
}
