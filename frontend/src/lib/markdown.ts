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
 * actions/code-blocks.ts highlights once the message is on screen and whose
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
const LIST_CLASS = "list-disc pl-5";
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
 */
const SPAN_RE = new RegExp(
  [
    String.raw`\\([\\\x60*~\[\]()#-])`,
    String.raw`\x60\x60\x60([^\n]+?)\x60\x60\x60`,
    String.raw`\x60([^\x60\n]+)\x60`,
    String.raw`\[([^\]\n]+)\]\((https?:\/\/[^\s()<>"]+)\)`,
    String.raw`(https?:\/\/[^\s<>"]+)`,
    String.raw`(@\[[^[\]]+\])`,
  ].join("|"),
  "gi",
);

/**
 * Text that reads as an address. A masked link showing one is how a link
 * that says one site and opens another is made, so it is not masked: the
 * real url shows instead. Tested with the markup taken out, so
 * "**paypal.com**" or "`paypal.com`" is still read as an address, and with
 * the dots that draw like one ("paypal․com").
 */
const LOOKS_LIKE_URL_RE = /:\/\/|\bwww[.\u2024\u3002\uFF0E\uFF61]|\w[.\u2024\u3002\uFF0E\uFF61][a-z]{2,}(?![a-z0-9])/i;
const looksLikeUrl = (label: string) => LOOKS_LIKE_URL_RE.test(label.replace(/[*~\x60\\]/g, ""));

/**
 * A url found in running text, without the punctuation that ends the
 * sentence around it: "see https://a.b/c." links to /c, and "(https://a.b)"
 * leaves the closing parenthesis out unless the url opened one itself.
 */
export function trimUrl(url: string): { url: string; rest: string } {
  let end = url.length;
  for (;;) {
    const ch = url[end - 1];
    if (/[.,!?;:'*~]/.test(ch)) {
      end--;
      continue;
    }
    if (ch === ")") {
      const body = url.slice(0, end);
      if ((body.match(/\(/g)?.length ?? 0) < (body.match(/\)/g)?.length ?? 0)) {
        end--;
        continue;
      }
    }
    break;
  }
  return { url: url.slice(0, end), rest: url.slice(end) };
}

function anchor(href: string, html: string, title?: string): string {
  const t = title ? ` title="${escapeHtml(title)}"` : "";
  return `<a href="${escapeHtml(href)}"${t} target="_blank" rel="noopener noreferrer" class="${LINK_CLASS}">${html}</a>`;
}

/** Code shows mentions by name, as text, and nothing else is interpreted. */
function code(src: string, resolveName: ResolveName): string {
  return escapeHtml(humanizeMentions(src, resolveName));
}

interface Delim {
  ch: "*" | "~";
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

/**
 * Bold, italic and strike over escaped text, matched with a delimiter stack
 * (CommonMark's idea, much simplified) so tags always nest: "***both***" is
 * <em><strong>, never <strong><em>…</strong></em>.
 *
 * A run opens when a non-space follows it and closes when a non-space comes
 * before it, so "2 * 3 * 4" stays arithmetic. A single * also needs a
 * non-word character outside it, so snake*case*word is left alone.
 *
 * One opener stack per marker, so a closer finds its opener on top instead
 * of walking past every opener of the other kind: linear, where one stack was
 * quadratic on a peer's "*a *a *a … a~~ a~~" - and this runs on every
 * notification and on the whole history when search rebuilds.
 */
function emphasis(html: string, tags = true): string {
  const parts: (string | Delim)[] = [];
  const stacks: Record<Delim["ch"], Delim[]> = { "*": [], "~": [] };
  let seq = 0;
  // Every run of tildes is taken whole: only a run of exactly two strikes,
  // so "~~~~a~~~~" stays text instead of pairing into two empty <s></s>.
  const RUN_RE = /\*+|~+/g;
  let last = 0;
  for (let m = RUN_RE.exec(html); m; m = RUN_RE.exec(html)) {
    const run = m[0];
    const before = html[m.index - 1];
    const after = html[m.index + run.length];
    const single = run === "*";
    const inert = run[0] === "~" && run.length !== 2;
    const d: Delim = {
      ch: run[0] as "*" | "~",
      seq: seq++,
      count: run.length,
      open: !inert && !!after && /\S/.test(after) && !(single && before !== undefined && /\w/.test(before)),
      close: !inert && !!before && /\S/.test(before) && !(single && after !== undefined && /\w/.test(after)),
      opens: [],
      closes: [],
    };
    parts.push(html.slice(last, m.index), d);
    last = m.index + run.length;

    const same = stacks[d.ch];
    const other = stacks[d.ch === "*" ? "~" : "*"];
    while (d.close && d.count > 0 && same.length > 0) {
      const o = same[same.length - 1];
      const n = d.ch === "~" || (o.count >= 2 && d.count >= 2) ? 2 : 1;
      const tag = d.ch === "~" ? "s" : n === 2 ? "strong" : "em";
      o.count -= n;
      d.count -= n;
      o.opens.unshift(tags ? `<${tag}>` : "");
      d.closes.push(tags ? `</${tag}>` : "");
      if (o.count === 0) same.pop();
      // Whatever of the other kind opened between the two stays literal: it
      // can no longer close without crossing this pair.
      while (other.length > 0 && other[other.length - 1].seq > o.seq) other.pop();
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

  let text = "";
  let last = 0;
  for (const m of src.matchAll(SPAN_RE)) {
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
        text += park(looksLikeUrl(named(label)) ? escapeHtml(whole) : inline(label, resolveName, false, true));
      } else {
        text +=
          !links || looksLikeUrl(named(label))
            ? park(`${escapeHtml(`[${label}](`)}${links ? anchor(href, escapeHtml(href)) : escapeHtml(href)})`)
            : park(anchor(href, inline(label, resolveName, false), href));
      }
    } else if (bare !== undefined) {
      const { url, rest } = trimUrl(bare);
      text += park(links && !plain ? anchor(url, escapeHtml(url)) : escapeHtml(url)) + escapeHtml(rest);
    } else if (mention !== undefined) {
      text += park(plain ? escapeHtml(humanizeMentions(mention, resolveName)) : humanize(mention, resolveName));
    }
  }
  text += escapeHtml(src.slice(last));

  const marked = plain ? emphasis(text, false) : wrapEmoji(emphasis(text));
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

/**
 * The first url the rendered message actually links to - a masked link's
 * target, or a bare url trimmed as it is rendered - for the link preview. A
 * url written as code is not a link, so it gets no preview either.
 */
export function firstLinkedUrl(content: string): string | null {
  if (typeof content !== "string") return null;
  for (const line of classify(content)) {
    if (line.kind === "fence") continue;
    for (const [, , , , , href, bare] of line.text.matchAll(SPAN_RE)) {
      if (href !== undefined) return href;
      if (bare !== undefined) return trimUrl(bare).url;
    }
  }
  return null;
}

type Line =
  | { kind: "fence"; lang: string; body: string }
  | { kind: "item"; text: string }
  | { kind: "heading"; level: number; text: string }
  | { kind: "text"; text: string };

/** The message's lines, each read as the one block construct it is. */
function classify(content: string): Line[] {
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
    const fence = fenceAt(lines, i, closeAt);
    if (fence) {
      if (fence.lead) out.push({ kind: "text", text: fence.lead });
      out.push({ kind: "fence", lang: fence.lang, body: fence.body });
      if (fence.tail) out.push({ kind: "text", text: fence.tail });
      i = fence.end;
      continue;
    }
    const item = /^\s*[-*]\s+(\S.*)$/.exec(lines[i]);
    if (item) {
      out.push({ kind: "item", text: item[1] });
      continue;
    }
    const heading = /^(#{1,3})\s+(\S.*)$/.exec(lines[i]);
    if (heading) {
      out.push({ kind: "heading", level: heading[1].length, text: heading[2] });
      continue;
    }
    out.push({ kind: "text", text: lines[i] });
  }
  return out;
}

/** One empty line, as a block: what a blank line beside a block becomes. */
const GAP = "<div><br></div>";

/**
 * The whole message. The container keeps `white-space: pre-wrap`, so plain
 * lines keep their newlines; a heading, a list or a code block already breaks
 * the line, so the newline beside one is dropped. A blank line beside one
 * would go with it - a newline next to a block draws nothing - so every
 * blank line in a run that touches a block is drawn as a line of its own.
 */
export function renderMessageMarkdown(content: string, resolveName: ResolveName): string {
  // Content is a claim about a JSON.parse result: a peer can send a number.
  if (typeof content !== "string") return "";
  const lines = classify(content);
  // `blank`: a line with nothing to draw, spaces included.
  const out: { block: boolean; blank?: boolean; html: string }[] = [];
  let items: string[] = [];
  const flushList = () => {
    if (!items.length) return;
    out.push({ block: true, html: `<ul class="${LIST_CLASS}">${items.join("")}</ul>` });
    items = [];
  };

  for (const line of lines) {
    if (line.kind === "item") {
      items.push(`<li>${inline(line.text, resolveName)}</li>`);
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
    } else if (line.kind === "heading") {
      const h = `h${line.level}`;
      out.push({ block: true, html: `<${h} class="${HEADING_CLASS[line.level]}">${inline(line.text, resolveName)}</${h}>` });
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

const ENTITIES: Record<string, string> = { "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" };

/**
 * The message as plain text, markup read and dropped: for a notification, a
 * reply quote, a pinned-list line or the search index, which all show text,
 * never HTML. Headings lose their #, list items read "• ", code keeps its
 * contents, a link its label.
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
  const html = classify(content)
    .map((line) => {
      if (line.kind === "fence") return code(line.body, name);
      const text = inline(line.text, name, true, true);
      return line.kind === "item" ? `• ${text}` : text;
    })
    .join("\n");
  return html.replace(/&(?:amp|lt|gt|quot|#39);/g, (e) => ENTITIES[e]);
}

/**
 * Where the message's masked links go. Their labels are what stripMarkdown
 * keeps, so the search index adds these for a search by domain to find them,
 * the way it adds filenames. Bare urls are in the stripped text already.
 */
export function linkTargets(content: string): string[] {
  if (typeof content !== "string") return [];
  const out: string[] = [];
  for (const line of classify(content)) {
    if (line.kind === "fence") continue;
    for (const [, , , , , href] of line.text.matchAll(SPAN_RE)) {
      if (href !== undefined) out.push(href);
    }
  }
  return out;
}
