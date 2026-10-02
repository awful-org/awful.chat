/**
 * Message markdown: the small subset a chat needs, rendered to HTML for
 * `{@html}`.
 *
 *   **bold**  *italic*  ~~strike~~  `code`  [text](https://…)  \* (literal)
 *   # / ## / ### headings, "- " or "* " list items, ``` fenced blocks
 *
 * plus what message bodies always had: bare urls, @[did] mentions, emoji.
 *
 * Nothing from the message reaches the output unescaped. Spans whose insides
 * must not be read as markdown - code, links, urls, mentions, backslash
 * escapes - are rendered first and parked behind placeholders. The text
 * between them is escaped, emphasis is applied to the ESCAPED text (an entity
 * holds no marker character, and a url is already parked, so a tag can never
 * land inside an attribute), and the placeholders go back last. Links are
 * http(s) only, by construction of the pattern that finds them.
 *
 * Not text-preview.ts's renderMarkdown, which previews a .md FILE with the
 * whole of CommonMark: a chat line has no business loading an image from a
 * url (that bypasses the external-media switch) or laying out a table.
 */
import { escapeHtml, humanize, humanizeMentions, wrapEmoji } from "./mentions";

type ResolveName = (did: string) => string;

const LINK_CLASS = "text-primary hover:underline";
const CODE_CLASS = "rounded bg-muted px-1 py-0.5 font-mono text-[0.85em]";
/**
 * A fenced block: the box, a copy button, and a <pre data-lang> that
 * actions/message-body.ts highlights once the message is on screen and whose
 * button it answers. Every block gets both, not only a message's first.
 */
const CODE_BLOCK_CLASS =
  "relative my-1 overflow-x-auto rounded-md border border-border/70 bg-muted/30 p-2 [&_.shiki]:bg-transparent!";
const PRE_CLASS = "whitespace-pre pr-9 font-mono text-[0.85em]";
const COPY_CLASS =
  "group/copy absolute right-2 top-2 z-10 inline-flex size-7 cursor-pointer items-center justify-center rounded border border-border/70 bg-card text-muted-foreground hover:text-foreground";
const ICON_ATTRS =
  'xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"';
/** Lucide's copy and check, swapped by the button's data-copied. */
const COPY_ICONS =
  `<svg ${ICON_ATTRS} class="group-data-[copied]/copy:hidden"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/></svg>` +
  `<svg ${ICON_ATTRS} class="hidden group-data-[copied]/copy:block"><path d="M20 6 9 17l-5-5"/></svg>`;
/** Bullets by depth, so a nested list reads as nested. */
const BULLET_CLASS = ["list-disc", "list-[circle]", "list-[square]", "list-[square]"];
const QUOTE_CLASS = "my-0.5 border-l-4 border-muted-foreground/40 pl-3";
const SUBTEXT_CLASS = "text-[0.8em] text-muted-foreground";
/**
 * Hidden until clicked (actions/message-body.ts sets data-revealed): the
 * text goes transparent and anything inside - an emoji, a link, a mention -
 * invisible, which also keeps a link from being followed before it is seen.
 */
const SPOILER_CLASS =
  "cursor-pointer rounded-sm bg-muted-foreground/40 px-0.5 not-data-revealed:text-transparent not-data-revealed:[&_*]:invisible data-revealed:cursor-auto data-revealed:bg-muted/60";
const HEADING_CLASS: Record<number, string> = {
  1: "text-[1.5em] font-bold leading-tight",
  2: "text-[1.25em] font-bold leading-tight",
  3: "text-[1.1em] font-semibold leading-tight",
};

/**
 * A parked span's placeholder is `<n>`. Only the text between spans is
 * escaped, and escaped text never holds "<", so a message cannot forge one
 * and no character of its own has to be given up for them.
 */
const PARKED_RE = /<(\d+)>/g;

/**
 * Spans taken whole, leftmost first: a backslash escape, ```code```, `code`,
 * a masked link, a bare url, a mention token.
 *
 * A masked link's label holds no "[", so "[a [b](…)" links "b", as in
 * CommonMark. A label that ran on across "[" made every "[" of a peer's run
 * of them rescan the rest of the line for a "]": quadratic, on every render.
 */
const SPAN_RE = new RegExp(
  [
    String.raw`\\([\\\x60*~_|>\[\]()#-])`,
    String.raw`\x60\x60\x60([^\n]+?)\x60\x60\x60`,
    String.raw`\x60([^\x60\n]+)\x60`,
    String.raw`\[([^[\]\n]+)\]\((https?:\/\/[^\s()<>"]+)\)`,
    String.raw`(https?:\/\/[^\s<>"]+)`,
    String.raw`(@\[[^[\]]+\])`,
  ].join("|"),
  "gi",
);

/**
 * Text that reads as an address. A masked link showing one is how a link
 * that says one site and opens another is made, so it is not masked: the
 * real url shows instead.
 *
 * Tested as it draws, not as it is spelled: "paypal.com" with a zero-width
 * space after the dot, or a Greek ο in "com", passed for plain text.
 *  - The markup goes ("**paypal.com**", "`paypal.com`"), and so does what
 *    draws as nothing: zero-width characters, soft hyphens, joiners,
 *    variation selectors, tag characters, combining marks, and the spaces
 *    narrower than a word space ("paypal .com" with a thin one).
 *  - Compatibility forms fold ("ｐａｙｐａｌ．ｃｏｍ"), and what draws as a dot
 *    reads as one ("paypal․com", "paypalꓸcom"). Not the middle dot, drawn
 *    raised, which passes for a full stop only at a glance: French and
 *    Catalan write it between letters ("étudiant·es", "col·lecció").
 *  - Anything else outside ASCII, a letter, a digit or a symbol, reads as
 *    a character that could pass for an ASCII one, so "paypal.cοm" and
 *    "paypa∣.com" are addresses. Not Chinese or Japanese, whose sentences
 *    run on after a full stop with no space between, nor the letters of
 *    scripts that write one inside a word ("จ.เชียงใหม่", "மு.கருணாநிதி"):
 *    Unicode's confusables list has none of those letters passing for an
 *    ASCII one, only their digits, which still count.
 * Text that can lay itself out in another order than it is spelled is
 * never masked: an override draws "t.co" from text that spells "oc.t", and
 * between two right-to-left marks "w.3org" draws as "w3.org".
 */
const LOOKS_LIKE_URL_RE = /:\/\/|\bwww\.|\w\.[a-z]{2,}(?![a-z0-9])/i;
/**
 * Markup, and what draws as nothing or almost nothing: the spaces narrower
 * than a word space (six-per-em, punctuation, thin, hair, narrow no-break)
 * go before NFKD would make them an ordinary space. An ordinary space stays,
 * so "e.g. this" is no address.
 */
const UNSEEN_RE = /[\p{Default_Ignorable_Code_Point}\u2006\u2008-\u200A\u202F*~_|\x60\\]/gu;
/**
 * A full stop, or what Unicode's confusables list says draws as one. An
 * Arabic-Indic zero only outside a number: between two such digits it is
 * part of one, and a label holding the year 2024 is no address, but beside
 * just one it is a dot, since one of them passes for an l and five for an
 * o. The Meetei Mayek heavy tone mark only where it marks no Meetei
 * syllable.
 */
const DOT_LIKE_RE =
  /[\u0701\u0702\u3002\uA4F8\uA60E\u{10A50}\u{1D16D}\u{1ECAE}]|(?<!\p{Script=Meetei_Mayek})\uABEC|(?<![\u0660-\u0669\u06F0-\u06F9])[\u0660\u06F0]|[\u0660\u06F0](?![\u0660-\u0669\u06F0-\u06F9])/gu;
const MARK_RE = /\p{M}/gu;
/**
 * By script extension, so the marks Japanese shares between its scripts
 * (the long vowel mark, the middle dot) count as Japanese too. The other
 * scripts by script alone, and their letters only: their digits, and a
 * Devanagari danda (which passes for an l, and which Bengali and others
 * share), still read as look-alikes.
 */
const LOOKALIKE_RE =
  /(?!(?=\p{L})[\p{Script=Thai}\p{Script=Lao}\p{Script=Khmer}\p{Script=Devanagari}\p{Script=Bengali}\p{Script=Gurmukhi}\p{Script=Gujarati}\p{Script=Tamil}\p{Script=Telugu}\p{Script=Kannada}\p{Script=Sinhala}])[^\p{ASCII}\p{Script_Extensions=Han}\p{Script_Extensions=Hiragana}\p{Script_Extensions=Katakana}]/gu;
/** Bidi overrides, embeddings and isolates. */
const REORDERS_RE = /[\u202A-\u202E\u2066-\u2069]/;
const REORDERS_ALL_RE = new RegExp(REORDERS_RE.source, "g");
/**
 * The right-to-left marks: invisible, and enough to turn the digits and
 * punctuation between two of them around.
 */
const RTL_MARK_RE = /[\u061C\u200F]/;
function looksLikeUrl(label: string): boolean {
  if (REORDERS_RE.test(label) || RTL_MARK_RE.test(label)) return true;
  const drawn = label
    .replace(UNSEEN_RE, "")
    .normalize("NFKD")
    .replace(DOT_LIKE_RE, ".")
    .replace(MARK_RE, "")
    .replace(LOOKALIKE_RE, "x");
  return LOOKS_LIKE_URL_RE.test(drawn);
}

/**
 * A url found in running text, without the punctuation that ends the
 * sentence around it: "see https://a.b/c." links to /c, and "(https://a.b)"
 * leaves the closing parenthesis out unless the url opened one itself.
 *
 * The parentheses are counted once and the count kept as they are dropped:
 * recounting the url for every ")" was quadratic, and a peer's url followed
 * by 16k of them held every render of the message for seconds. Only ")" and
 * punctuation are ever dropped, so the count of "(" never changes.
 */
export function trimUrl(url: string): { url: string; rest: string } {
  let opened = 0;
  let closed = 0;
  for (const ch of url) {
    if (ch === "(") opened++;
    else if (ch === ")") closed++;
  }
  let end = url.length;
  for (;;) {
    const ch = url[end - 1];
    if (/[.,!?;:'*~_|]/.test(ch)) {
      end--;
      continue;
    }
    if (ch === ")" && opened < closed) {
      end--;
      closed--;
      continue;
    }
    break;
  }
  return { url: url.slice(0, end), rest: url.slice(end) };
}

/**
 * A link, with no bidi control in its text or its title (the href keeps
 * them: the browser encodes them).
 *
 * A url shown as itself is a bidi isolate laid out left to right. An
 * override typed before it and closed after it reversed it, so a bare url
 * drew as another host's; one inside it reversed the rest of it, and
 * "https://" with "moc.lapyap@evil.example" after an override drew as a
 * link to paypal.com. Not dir="auto" nor <bdi>: an invisible right-to-left
 * mark at its start then turns it around again.
 *
 * A masked link is no isolate. An isolate is laid out as one piece, and
 * right-to-left text puts the pieces in its own order, so
 * "[.com](…)[paypal](…)" drew as one link to paypal.com between two Hebrew
 * words, or between two invisible right-to-left marks. As text of the line,
 * a left-to-right letter never moves, and no override reaches it: a line
 * holding one masks no link (see linksShowingUrls).
 */
function anchor(href: string, html: string, masked = false): string {
  const title = masked ? ` title="${escapeHtml(href.replace(REORDERS_ALL_RE, ""))}"` : "";
  const dir = masked ? "" : ' dir="ltr"';
  const text = html.replace(REORDERS_ALL_RE, "");
  return `<a href="${escapeHtml(href)}"${title} target="_blank" rel="noopener noreferrer"${dir} class="${LINK_CLASS}">${text}</a>`;
}

/**
 * A word, as an address is one: what lies between two spaces the address
 * test reads as spaces. Not the spaces narrower than a word space, which it
 * drops, nor an ogham space mark or a line separator, which it reads as a
 * letter.
 */
const SPACELESS_RE = /[^\t-\r \u00A0\u2000-\u2005\u2007\u205F\u3000]+/g;

/**
 * Which of a line's spans are masked links that show their url instead of
 * their label, read off the line as it draws: a masked link as its label,
 * a mention as its name.
 *  - Every link in a word that reads as an address. Labels that touch draw
 *    as one word: "[paypal](…)[.com](…)" was two links, neither label an
 *    address alone, that drew as one link to paypal.com, and
 *    "[paypal](…).com" drew the same in two colours.
 *  - Every link in a line holding a bidi override, embedding or isolate,
 *    which can lay the line out in any order.
 * Each word is read once, so a line of touching links stays linear.
 */
function linksShowingUrls(src: string, spans: RegExpExecArray[], named: (text: string) => string): boolean[] {
  const shown = spans.map(() => false);
  const links: { k: number; start: number; end: number }[] = [];
  let line = "";
  let last = 0;
  spans.forEach((m, k) => {
    const [whole, , , , label, href, bare, mention] = m;
    line += src.slice(last, m.index);
    last = m.index + whole.length;
    if (label !== undefined && href !== undefined) {
      const text = named(label);
      links.push({ k, start: line.length, end: line.length + text.length });
      line += text;
    } else if (bare !== undefined) {
      // As anchor draws it.
      line += whole.replace(REORDERS_ALL_RE, "");
    } else {
      line += mention !== undefined ? named(whole) : whole;
    }
  });
  line += src.slice(last);

  if (REORDERS_RE.test(line)) {
    for (const { k } of links) shown[k] = true;
    return shown;
  }
  let i = 0;
  for (const word of line.matchAll(SPACELESS_RE)) {
    const start = word.index;
    const end = start + word[0].length;
    while (i < links.length && links[i].end <= start) i++;
    if (i === links.length) break;
    if (links[i].start >= end || !looksLikeUrl(word[0])) continue;
    for (let j = i; j < links.length && links[j].start < end; j++) shown[links[j].k] = true;
  }
  return shown;
}

/** Code shows mentions by name, as text, and nothing else is interpreted. */
function code(src: string, resolveName: ResolveName): string {
  return escapeHtml(humanizeMentions(src, resolveName));
}

type Marker = "*" | "_" | "~" | "|";

interface Delim {
  ch: Marker;
  /** Where the run sits among all runs, to tell which opened first. */
  seq: number;
  /** Markers not yet used by a match; they render as literal text. */
  count: number;
  open: boolean;
  close: boolean;
  /** Innermost last. */
  opens: string[];
  /** Innermost first. */
  closes: string[];
}

const MARKERS: Marker[] = ["*", "_", "~", "|"];

/**
 * A letter or digit, in any script. Not \w: that counts "_" as a letter, so
 * the * in "__*a*__" read as mid-word, and it knows only ASCII.
 */
const WORD_RE = /[\p{L}\p{N}]/u;

/** What a matched pair of `n` markers becomes. */
function tagFor(ch: Marker, n: number): string {
  if (ch === "~") return "s";
  if (ch === "|") return "spoiler";
  if (ch === "_") return n === 2 ? "u" : "em";
  return n === 2 ? "strong" : "em";
}

/**
 * Bold, italic, underline, strike and spoilers over escaped text, matched
 * with a delimiter stack (CommonMark's idea, much simplified) so tags always
 * nest: "***both***" is <em><strong>, never <strong><em>…</strong></em>.
 *
 *   *a* _a_ italic   **a** bold   __a__ underline   ~a~ ~~a~~ strike
 *   ||a|| spoiler
 *
 * A run opens when a non-space follows it and closes when a non-space comes
 * before it, so "2 * 3 * 4" stays arithmetic. A single * or ~, and any run
 * of _, also needs a non-word character outside it, so snake_case,
 * snake*case*word and file~1~ are left alone. Strike takes one tilde or two
 * and a spoiler exactly two bars, closed by the same count: ~a~~ does not
 * strike, and a lone | is just a bar.
 *
 * One opener stack per marker, so a closer finds its opener on top instead
 * of walking past every opener of another kind: linear, where one stack was
 * quadratic on a peer's "*a *a *a … a~~ a~~" - and this runs on every
 * notification and on the whole history when search rebuilds.
 *
 * With `tags` off (plain text) every tag is dropped except a spoiler's,
 * which becomes "<|>…</|>" for the caller to replace: escaped text never
 * holds "<", so the pair cannot be forged.
 */
function emphasis(html: string, tags = true): string {
  const parts: (string | Delim)[] = [];
  const stacks: Record<Marker, Delim[]> = { "*": [], "_": [], "~": [], "|": [] };
  let seq = 0;
  // Every run is taken whole, so "~~~~a~~~~" or "|||" stays text instead of
  // pairing into empty tags.
  const RUN_RE = /\*+|_+|~+|\|+/g;
  let last = 0;
  for (let m = RUN_RE.exec(html); m; m = RUN_RE.exec(html)) {
    const run = m[0];
    const ch = run[0] as Marker;
    const before = html[m.index - 1];
    const after = html[m.index + run.length];
    const inert = (ch === "~" && run.length > 2) || (ch === "|" && run.length !== 2);
    const wordy = ch === "_" || ((ch === "*" || ch === "~") && run.length === 1);
    const spaced = ch !== "|";
    const d: Delim = {
      ch,
      seq: seq++,
      count: run.length,
      open:
        !inert && !!after && (!spaced || /\S/.test(after)) &&
        !(wordy && before !== undefined && WORD_RE.test(before)),
      close:
        !inert && !!before && (!spaced || /\S/.test(before)) &&
        !(wordy && after !== undefined && WORD_RE.test(after)),
      opens: [],
      closes: [],
    };
    parts.push(html.slice(last, m.index), d);
    last = m.index + run.length;

    const same = stacks[ch];
    while (d.close && d.count > 0 && same.length > 0) {
      const o = same[same.length - 1];
      const exact = ch === "~" || ch === "|";
      if (exact && o.count !== d.count) break;
      const n = exact ? d.count : o.count >= 2 && d.count >= 2 ? 2 : 1;
      const tag = tagFor(ch, n);
      o.count -= n;
      d.count -= n;
      if (tag === "spoiler") {
        o.opens.unshift(
          tags
            ? `<span class="${SPOILER_CLASS}" data-spoiler role="button" tabindex="0" aria-label="Spoiler, press to reveal">`
            : "<|>",
        );
        d.closes.push(tags ? "</span>" : "</|>");
      } else {
        o.opens.unshift(tags ? `<${tag}>` : "");
        d.closes.push(tags ? `</${tag}>` : "");
      }
      if (o.count === 0) same.pop();
      // Whatever of another kind opened between the two stays literal: it
      // can no longer close without crossing this pair.
      for (const k of MARKERS) {
        if (k === ch) continue;
        const other = stacks[k];
        while (other.length > 0 && other[other.length - 1].seq > o.seq) other.pop();
      }
    }
    if (d.open && d.count > 0) same.push(d);
  }
  parts.push(html.slice(last));

  return parts
    .map((p) =>
      typeof p === "string" ? p : p.closes.join("") + p.ch.repeat(p.count) + p.opens.join(""),
    )
    .join("");
}

/**
 * One line of text. `links` is off inside a link's own label. `plain` reads
 * the same markup and drops it: markers consumed, no tags, mention tokens left
 * for the caller to name - still escaped, like every other result here.
 */
function inline(src: string, resolveName: ResolveName, links = true, plain = false): string {
  // A label as it will read, mentions named: a peer whose display name is
  // "paypal.com/login" is an address too, once "[@[their did]](…)" renders.
  const named = (label: string) => humanizeMentions(label, resolveName);
  const parked: string[] = [];
  const park = (html: string) => `<${parked.push(html) - 1}>`;

  const spans = [...src.matchAll(SPAN_RE)];
  const showsUrl = linksShowingUrls(src, spans, named);
  let text = "";
  let last = 0;
  for (const [k, m] of spans.entries()) {
    const [whole, escaped, fenced, tick, label, href, bare, mention] = m;
    text += escapeHtml(src.slice(last, m.index));
    last = m.index + whole.length;
    if (escaped !== undefined) {
      text += park(escapeHtml(escaped));
    } else if (fenced !== undefined || tick !== undefined) {
      const body = fenced ?? tick!;
      text += park(plain ? code(body, resolveName) : `<code class="${CODE_CLASS}">${code(body, resolveName)}</code>`);
    } else if (label !== undefined && href !== undefined) {
      if (plain) {
        // Not clickable here, but a notification that reads "paypal.com"
        // for a link to somewhere else still lies: keep the look-alike whole.
        text += park(showsUrl[k] ? escapeHtml(whole) : inline(label, resolveName, false, true));
      } else {
        text +=
          !links || showsUrl[k]
            ? park(`${escapeHtml(`[${label}](`)}${links ? anchor(href, escapeHtml(href)) : escapeHtml(href)})`)
            : park(anchor(href, inline(label, resolveName, false), true));
      }
    } else if (bare !== undefined) {
      const { url, rest } = trimUrl(bare);
      text += park(links && !plain ? anchor(url, escapeHtml(url)) : escapeHtml(url)) + escapeHtml(rest);
    } else if (mention !== undefined) {
      text += park(plain ? escapeHtml(humanizeMentions(mention, resolveName)) : humanize(mention, resolveName));
    }
  }
  text += escapeHtml(src.slice(last));

  // Plain text shows a spoiler as what it is, never what it hides: a
  // notification or a quote would otherwise give it away.
  const marked = plain
    ? emphasis(text, false).replace(/<\|>[^]*?<\/\|>/g, "[spoiler]")
    : wrapEmoji(emphasis(text));
  return marked.replace(PARKED_RE, (_, i: string) => parked[Number(i)]);
}

interface Fence {
  /** Text on the opening line before the fence ("look: ```js"). */
  lead: string;
  /** Text on the closing line after the fence ("``` done"). */
  tail: string;
  lang: string;
  body: string;
  /** Index of the closing line. */
  end: number;
}

const FENCE_OPEN_RE = /^(.*?)```([\w-]*)\s*$/;
const FENCE_CLOSE_RE = /^(.*?)```\s*$/;
/** "``` done": a close with words after it, which the words then follow. */
const FENCE_CLOSE_THEN_RE = /^```\s+(\S.*)$/;
const closesFence = (line: string) => {
  const close = FENCE_CLOSE_RE.exec(line);
  return (!!close && !close[1].includes("`")) || FENCE_CLOSE_THEN_RE.test(line);
};

/**
 * The fenced block opened at `lines[i]`, or null. A fence only counts once
 * it closes; an unclosed one is plain text. Chat writes fences loosely, and
 * both of these were code before markdown and stay code: an opening fence
 * after some words ("look: ```js"), a closing one on the last line of code
 * ("}```"), and a closing one followed by words ("``` done"). "```js" never
 * closes a fence, so a fence written out inside code stays inside it.
 *
 * `closeAt[k]` is the first closing line at or after k (-1 for none), found
 * once per message: scanning ahead from every opener was quadratic, and a
 * peer's message of nothing but "```a" lines stalled every render of it for
 * seconds.
 */
function fenceAt(lines: string[], i: number, closeAt: number[]): Fence | null {
  const open = FENCE_OPEN_RE.exec(lines[i]);
  if (!open || open[1].includes("`")) return null;
  const end = closeAt[i + 1];
  if (end === -1) return null;
  const body = lines.slice(i + 1, end);
  const then = FENCE_CLOSE_THEN_RE.exec(lines[end]);
  const last = then ? "" : FENCE_CLOSE_RE.exec(lines[end])![1];
  if (last.trim()) body.push(last);
  return { lead: open[1].trim(), tail: then?.[1] ?? "", lang: open[2], body: body.join("\n"), end };
}

type Line =
  | { kind: "fence"; lang: string; body: string }
  | { kind: "quote"; body: string }
  | { kind: "item"; ordered: false; depth: number; text: string }
  | { kind: "item"; ordered: true; n: number; depth: number; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "subtext"; text: string }
  | { kind: "text"; text: string };

type Item = Extract<Line, { kind: "item" }>;

/** Two spaces, or a tab, per level of list nesting; three levels at most. */
function depthOf(indent: string): number {
  const width = indent.replace(/\t/g, "  ").length;
  return Math.min(3, Math.floor(width / 2));
}

/**
 * The message's lines, each read as the one block construct it is.
 * `quotes` is off inside a quote: a quote does not nest.
 */
function classify(content: string, quotes = true): Line[] {
  // A peer's client may send CRLF: a stray \r would keep a heading or an
  // empty line from reading as one.
  const lines = content.split(/\r?\n/);
  const closeAt: number[] = new Array(lines.length + 1);
  closeAt[lines.length] = -1;
  for (let k = lines.length - 1; k >= 0; k--) {
    closeAt[k] = closesFence(lines[k]) ? k : closeAt[k + 1];
  }
  const out: Line[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Before fences: "> ```js" opens a fence inside the quote, not a fence
    // after a "> " lead that leaves the quote marks in the code.
    if (quotes) {
      // ">>> " quotes everything after it, to the end of the message.
      const rest = /^>>>(?: (.*))?$/.exec(line);
      if (rest) {
        const body = [rest[1] ?? "", ...lines.slice(i + 1)].join("\n");
        // A quote of nothing is no quote: a lone ">>>" stays text.
        if (body.trim()) {
          out.push({ kind: "quote", body });
          break;
        }
      }
      // "> " quotes its line; a run of them is one quote.
      if (/^>(?: |$)/.test(line)) {
        let end = i;
        while (end < lines.length && /^>(?: |$)/.test(lines[end])) end++;
        const body = lines.slice(i, end).map((l) => l.slice(2)).join("\n");
        // Lines of bare ">" quote nothing and stay text, all of the run at
        // once: rescanning it from each of its lines was quadratic.
        if (body.trim()) out.push({ kind: "quote", body });
        else for (let k = i; k < end; k++) out.push({ kind: "text", text: lines[k] });
        i = end - 1;
        continue;
      }
    }
    const fence = fenceAt(lines, i, closeAt);
    if (fence) {
      if (fence.lead) out.push({ kind: "text", text: fence.lead });
      out.push({ kind: "fence", lang: fence.lang, body: fence.body });
      if (fence.tail) out.push({ kind: "text", text: fence.tail });
      i = fence.end;
      continue;
    }
    const subtext = /^-# (\S.*)$/.exec(line);
    if (subtext) {
      out.push({ kind: "subtext", text: subtext[1] });
      continue;
    }
    const bullet = /^([ \t]*)[-*]\s+(\S.*)$/.exec(line);
    if (bullet) {
      out.push({ kind: "item", ordered: false, depth: depthOf(bullet[1]), text: bullet[2] });
      continue;
    }
    const numbered = /^([ \t]*)(\d{1,9})[.)]\s+(\S.*)$/.exec(line);
    if (numbered) {
      const n = Number(numbered[2]);
      out.push({ kind: "item", ordered: true, n, depth: depthOf(numbered[1]), text: numbered[3] });
      continue;
    }
    const heading = /^(#{1,3})\s+(\S.*)$/.exec(line);
    if (heading) {
      out.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    out.push({ kind: "text", text: line });
  }
  return out;
}

/** A spoiler's reach in raw text: "||" to the next "||" on the line. */
const SPOILED_RE = /(?<!\|)\|\|(?!\|)[^\n]*?(?<!\|)\|\|(?!\|)/g;

/**
 * The line with every spoiler blanked, its bars found where the renderer
 * finds them: not inside a span it parks (an escape, code, a link, a
 * mention), so "\|||a https://x.com||" hides the url here as it does on
 * screen, and a "||" written as code hides nothing.
 */
function withoutSpoilers(text: string): string {
  let mask = "";
  let last = 0;
  for (const m of text.matchAll(SPAN_RE)) {
    const bare = m[6];
    // A bare url's trimmed tail is text again, bars included.
    const parked = bare !== undefined ? trimUrl(bare).url.length : m[0].length;
    mask += text.slice(last, m.index) + " ".repeat(parked);
    last = m.index + parked;
  }
  mask += text.slice(last);
  let out = "";
  last = 0;
  for (const m of mask.matchAll(SPOILED_RE)) {
    out += text.slice(last, m.index) + " ";
    last = m.index + m[0].length;
  }
  return out + text.slice(last);
}

/**
 * Every stretch of inline text in the message, quotes included, fences not,
 * and spoilers left out: a link preview or a search snippet naming the site a
 * spoiler hides would give it away.
 */
function* inlineTexts(content: string, quotes = true): Generator<string> {
  for (const line of classify(content, quotes)) {
    if (line.kind === "fence") continue;
    if (line.kind === "quote") yield* inlineTexts(line.body, false);
    else yield withoutSpoilers(line.text);
  }
}

/**
 * The first url the rendered message actually links to - a masked link's
 * target, or a bare url trimmed as it is rendered - for the link preview. A
 * url written as code is not a link, so it gets no preview either.
 */
export function firstLinkedUrl(content: string): string | null {
  if (typeof content !== "string") return null;
  for (const text of inlineTexts(content)) {
    for (const [, , , , , href, bare] of text.matchAll(SPAN_RE)) {
      if (href !== undefined) return href;
      if (bare !== undefined) return trimUrl(bare).url;
    }
  }
  return null;
}

/** An open list: its kind, and how far in its first item was typed. */
interface OpenList {
  ordered: boolean;
  indent: number;
}

/**
 * Where list item `it` goes among the `open` lists, which it updates. It is
 * a sibling in the shallowest open list typed as far in as it is, so "- a",
 * "    - b", "    - c" keeps c beside b; with none, it opens a list one
 * level in, never more. A change between bullets and numbers at a depth
 * starts a new list there. `closed` is what it ends, innermost first.
 * renderList draws by this and stripBlocks indents by it, so the two agree.
 */
function nest(open: OpenList[], it: Item): { depth: number; fresh: boolean; closed: OpenList[] } {
  let depth = open.findIndex((l) => l.indent >= it.depth);
  if (depth === -1) depth = open.length;
  const fresh = open[depth]?.ordered !== it.ordered;
  const closed = open.splice(fresh ? depth : depth + 1).reverse();
  if (fresh) open.push({ ordered: it.ordered, indent: it.depth });
  return { depth, fresh, closed };
}

const endList = (l: OpenList) => (l.ordered ? "</li></ol>" : "</li></ul>");

/**
 * A run of list items as nested lists (see nest). A numbered list starts
 * where its first item says, as "3." does in the typed text.
 */
function renderList(items: Item[], resolveName: ResolveName): string {
  let html = "";
  const open: OpenList[] = [];
  for (const it of items) {
    const { depth, fresh, closed } = nest(open, it);
    html += closed.map(endList).join("");
    if (!fresh) html += "</li>";
    else
      html += it.ordered
        ? `<ol class="list-decimal pl-6"${it.n !== 1 ? ` start="${it.n}"` : ""}>`
        : `<ul class="${BULLET_CLASS[depth]} pl-5">`;
    html += `<li>${inline(it.text, resolveName)}`;
  }
  return html + open.reverse().map(endList).join("");
}

/** One empty line, as a block: what a blank line beside a block becomes. */
const GAP = "<div><br></div>";

function renderBlocks(content: string, resolveName: ResolveName, quotes: boolean): string {
  const lines = classify(content, quotes);
  // `blank`: a line with nothing to draw, spaces included.
  const out: { block: boolean; blank?: boolean; html: string }[] = [];
  let items: Item[] = [];
  const flushList = () => {
    if (!items.length) return;
    out.push({ block: true, html: renderList(items, resolveName) });
    items = [];
  };

  for (const line of lines) {
    if (line.kind === "item") {
      items.push(line);
      continue;
    }
    flushList();
    if (line.kind === "fence") {
      out.push({
        block: true,
        html:
          `<div class="${CODE_BLOCK_CLASS}" data-code-block>` +
          `<button type="button" class="${COPY_CLASS}" data-copy-code aria-label="Copy code">${COPY_ICONS}</button>` +
          `<pre class="${PRE_CLASS}" data-lang="${escapeHtml(line.lang || "text")}"><code>${code(line.body, resolveName)}</code></pre>` +
          `</div>`,
      });
    } else if (line.kind === "quote") {
      out.push({
        block: true,
        html: `<blockquote class="${QUOTE_CLASS}">${renderBlocks(line.body, resolveName, false)}</blockquote>`,
      });
    } else if (line.kind === "heading") {
      const h = `h${line.level}`;
      out.push({ block: true, html: `<${h} class="${HEADING_CLASS[line.level]}">${inline(line.text, resolveName)}</${h}>` });
    } else if (line.kind === "subtext") {
      out.push({ block: true, html: `<div class="${SUBTEXT_CLASS}">${inline(line.text, resolveName)}</div>` });
    } else {
      out.push({ block: false, blank: !line.text.trim(), html: inline(line.text, resolveName) });
    }
  }
  flushList();

  // Blank runs that touch a block become gaps.
  for (let k = 0; k < out.length; ) {
    if (!out[k].blank) {
      k++;
      continue;
    }
    let end = k;
    while (end < out.length && out[end].blank) end++;
    if (out[k - 1]?.block || out[end]?.block) {
      for (let j = k; j < end; j++) out[j] = { block: true, html: GAP };
    }
    k = end;
  }

  let html = "";
  for (let k = 0; k < out.length; k++) {
    if (k > 0 && !out[k].block && !out[k - 1].block) html += "\n";
    html += out[k].html;
  }
  return html;
}

/**
 * The whole message. The container keeps `white-space: pre-wrap`, so plain
 * lines keep their newlines; a heading, a list, a quote or a code block
 * already breaks the line, so the newline beside one is dropped. A blank
 * line beside one would go with it - a newline next to a block draws nothing
 * - so every blank line in a run that touches a block is drawn as a line of
 * its own.
 */
export function renderMessageMarkdown(content: string, resolveName: ResolveName): string {
  // Content is a claim about a JSON.parse result: a peer can send a number.
  if (typeof content !== "string") return "";
  return renderBlocks(content, resolveName, true);
}

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

function stripBlocks(content: string, name: ResolveName, quotes: boolean): string {
  // Items indent by the depth they render at, not as typed: "- a" then
  // "      - b" reads one level in, not three.
  let open: OpenList[] = [];
  return classify(content, quotes)
    .map((line) => {
      if (line.kind !== "item") open = [];
      if (line.kind === "fence") return code(line.body, name);
      if (line.kind === "quote") return stripBlocks(line.body, name, false);
      const text = inline(line.text, name, true, true);
      if (line.kind !== "item") return text;
      const indent = "  ".repeat(nest(open, line).depth);
      return line.ordered ? `${indent}${line.n}. ${text}` : `${indent}• ${text}`;
    })
    .join("\n");
}

/**
 * The message as plain text, markup read and dropped: for a notification, a
 * reply quote, a pinned-list line or the search index, which all show text,
 * never HTML. Headings and subtext lose their markers, a quote its ">",
 * bullets read "• " and numbers keep theirs, code keeps its contents, a link
 * its label, and a spoiler reads "[spoiler]" - never what it hides.
 *
 * Mentions are named HERE, from the tokens the message really carries, and
 * the result is final text: running humanizeMentions over it afterwards would
 * name an "@\[did\]" the sender escaped, a mention the message never made.
 * Without `resolveName` the tokens stay as written (the search index).
 */
export function stripMarkdown(content: string, resolveName?: ResolveName): string {
  if (typeof content !== "string") return "";
  // humanizeMentions writes "@" + name, so "[did]" as the name keeps the token.
  const name: ResolveName = resolveName ?? ((did) => `[${did}]`);
  return stripBlocks(content, name, true).replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]);
}

/**
 * Where the message's masked links go. Their labels are what stripMarkdown
 * keeps, so the search index adds these for a search by domain to find them,
 * the way it adds filenames. Bare urls are in the stripped text already.
 */
export function linkTargets(content: string): string[] {
  if (typeof content !== "string") return [];
  const out: string[] = [];
  for (const text of inlineTexts(content)) {
    for (const [, , , , , href] of text.matchAll(SPAN_RE)) {
      if (href !== undefined) out.push(href);
    }
  }
  return out;
}
