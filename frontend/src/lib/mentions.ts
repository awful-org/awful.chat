/**
 * Mention token handling for @-mentions in chat.
 *
 * Wire format: mentions live inside msg.content as tokens `@[<did>]`, e.g.
 * `@[did:key:z6Mk...]`. Content is covered by message signature, so mentions
 * are tamper-proof.
 */

/** One run of draft text, tagged with the DID when it is a real mention. */
export interface DraftSegment {
  /** The text exactly as it appears in the draft (mentions keep their `@`). */
  text: string;
  /** DID for a recorded mention, `null` for plain text. */
  did: string | null;
}

/**
 * Split a draft into plain-text and mention runs.
 *
 * This is the single place that decides which `@Name` in a draft is a real
 * mention. Both the wire serializer and the composer's highlight read it, so
 * what the user sees highlighted is exactly what gets signed as `@[did]` -
 * they cannot drift apart.
 *
 * Only names the user picked from the mention popup count. Hand-typed
 * `@Charlie` stays literal text, and `@Alice-bot` does not match `Alice`.
 *
 * @param content The draft with human-readable names
 * @param nameToDidMap Map from display names to DIDs
 * @returns The draft split into consecutive segments (concatenating `text`
 *   reproduces `content` exactly)
 */
export function segmentDraft(
  content: string,
  nameToDidMap: Map<string, string>
): DraftSegment[] {
  if (!content) return [];

  // Longest name first: a JS alternation takes the first branch that matches
  // at a position, so this order IS the collision precedence. With both "Ana"
  // and "Anna" recorded, "@Anna" must not resolve to "Ana".
  const names = Array.from(nameToDidMap.keys()).sort(
    (a, b) => b.length - a.length
  );
  if (names.length === 0) return [{ text: content, did: null }];

  // The trailing guard keeps "@Alice-bot" and "@Alices" literal.
  const pattern = new RegExp(
    `@(?:${names.map(escapeRegex).join("|")})(?![\\w-])`,
    "g"
  );

  const segments: DraftSegment[] = [];
  let cursor = 0;

  for (const match of content.matchAll(pattern)) {
    const did = nameToDidMap.get(match[0].slice(1));
    if (did === undefined) continue;
    if (match.index > cursor) {
      segments.push({ text: content.slice(cursor, match.index), did: null });
    }
    segments.push({ text: match[0], did });
    cursor = match.index + match[0].length;
  }

  if (cursor < content.length) {
    segments.push({ text: content.slice(cursor), did: null });
  }

  return segments;
}

/**
 * Replace all recorded @Name mentions with @[did] tokens in content.
 * Unrecorded @something text is left untouched.
 *
 * @param content The message content with human-readable names
 * @param nameToDidMap Map from display names to DIDs
 * @returns Content with @Name replaced by @[did] tokens
 */
export function serialize(
  content: string,
  nameToDidMap: Map<string, string>
): string {
  return segmentDraft(content, nameToDidMap)
    .map((segment) =>
      segment.did === null ? segment.text : `@[${segment.did}]`
    )
    .join("");
}

/**
 * Convert @[did] tokens in content to human-readable @Name mentions.
 * Resolves current display names at render time for rename-proof display.
 *
 * @param content The message content with @[did] tokens
 * @param resolveName Function to resolve a DID to its display name
 * @returns Content with @[did] tokens replaced by mention chips (as HTML)
 */
export function humanize(
  content: string,
  resolveName: (did: string) => string
): string {
  // Same reason as escapeHtml's coercion, one level up: `content` is a
  // TypeScript claim about a JSON.parse result, so a peer can send a number or
  // an object and it still signs and verifies. `.replace` on those throws, and
  // callers run on paths where one throw loses the message - the DM receive
  // path's only handler is .catch(console.error), so the throw skips the
  // append and the DM stays invisible until reload.
  if (typeof content !== "string") return "";
  // Match @[did] tokens
  // Allow any characters inside the brackets that are valid in a DID
  return content.replace(/@\[([^\[\]]+)\]/g, (match, did) => {
    // Names are PEER-CONTROLLED and this string ends up inside {@html}:
    // escaping here is what stands between a nickname like
    // "<img onerror=...>" and script execution in every viewer.
    const name = escapeHtml(resolveName(did));
    return `<span class="font-medium text-primary">@${name}</span>`;
  });
}

/**
 * Convert @[did] tokens in content to human-readable @Name mentions as plain text.
 * Used for previews and notifications where HTML is not appropriate.
 * Resolves current display names at render time for rename-proof display.
 *
 * @param content The message content with @[did] tokens
 * @param resolveName Function to resolve a DID to its display name
 * @returns Content with @[did] tokens replaced by plain text @Name
 */
export function humanizeMentions(
  content: string,
  resolveName: (did: string) => string
): string {
  // Non-string content is treated as empty here for the same reason as in
  // humanize above: this is the notification-body path, and on DM receive a
  // throw here skips the rest of the delivery bookkeeping.
  if (typeof content !== "string") return "";
  // Match @[did] tokens
  return content.replace(/@\[([^\[\]]+)\]/g, (match, did) => {
    const name = resolveName(did);
    return `@${name}`;
  });
}

/**
 * Check if content mentions the given DID(s).
 * Compares against both DID forms for compatibility.
 *
 * @param content The message content
 * @param selfDids One or more DIDs to check against (typically identity did + transport selfId)
 * @returns true if any of the selfDids are mentioned in content
 */
export function mentionsMe(content: string, selfDids: string[]): boolean {
  // Match @[did] tokens
  const mentionedDids = new Set<string>();
  const regex = /@\[([^\[\]]+)\]/g;
  let match;

  while ((match = regex.exec(content)) !== null) {
    mentionedDids.add(match[1]);
  }

  // Check if any of our DIDs are mentioned
  return selfDids.some((did) => mentionedDids.has(did));
}

/**
 * Escape special regex characters in a string.
 * Used to safely include user-provided names in regex patterns.
 *
 * @param str The string to escape
 * @returns The escaped string safe for use in regex
 */
function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function escapeHtml(str: unknown): string {
  // Coerced, not assumed: display names come off the wire with no runtime type
  // check, so resolveName can hand back a number or an object. `.replace` on
  // those throws, and this is the {@html} mention path - one malformed profile
  // would kill the render of every message that mentions it.
  return String(str)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
