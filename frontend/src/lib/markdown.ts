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
const PRE_CLASS =
  "my-1 overflow-x-auto whitespace-pre rounded-md border border-border/70 bg-muted/30 p-2 font-mono text-[0.85em]";
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
 */
function emphasis(html: string): string {
  const parts: (string | Delim)[] = [];
  const stack: Delim[] = [];
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
      count: run.length,
      open: !inert && !!after && /\S/.test(after) && !(single && before !== undefined && /\w/.test(before)),
      close: !inert && !!before && /\S/.test(before) && !(single && after !== undefined && /\w/.test(after)),
      opens: [],
      closes: [],
    };
    parts.push(html.slice(last, m.index), d);
    last = m.index + run.length;

    if (d.close) {
      for (let i = stack.length - 1; i >= 0 && d.count > 0; ) {
        const o = stack[i];
        if (o.ch !== d.ch) {
          i--;
          continue;
        }
        const n = d.ch === "~" || (o.count >= 2 && d.count >= 2) ? 2 : 1;
        const tag = d.ch === "~" ? "s" : n === 2 ? "strong" : "em";
        o.count -= n;
        d.count -= n;
        o.opens.unshift(`<${tag}>`);
        d.closes.push(`</${tag}>`);
        // Whatever opened between the two stays literal: it can no longer
        // close without crossing this pair.
        stack.length = o.count > 0 ? i + 1 : i;
        i = stack.length - 1;
      }
    }
    if (d.open && d.count > 0) stack.push(d);
  }
  parts.push(html.slice(last));

  return parts
    .map((p) =>
      typeof p === "string" ? p : p.closes.join("") + p.ch.repeat(p.count) + p.opens.join(""),
    )
    .join("");
}

/** One line of text. `links` is off inside a link's own label. */
function inline(src: string, resolveName: ResolveName, links = true): string {
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
      text += park(`<code class="${CODE_CLASS}">${code(fenced ?? tick!, resolveName)}</code>`);
    } else if (label !== undefined && href !== undefined) {
      text +=
        !links || looksLikeUrl(label)
          ? park(`${escapeHtml(`[${label}](`)}${links ? anchor(href, escapeHtml(href)) : escapeHtml(href)})`)
          : park(anchor(href, inline(label, resolveName, false), href));
    } else if (bare !== undefined) {
      const { url, rest } = trimUrl(bare);
      text += park(links ? anchor(url, escapeHtml(url)) : escapeHtml(url)) + escapeHtml(rest);
    } else if (mention !== undefined) {
      text += park(humanize(mention, resolveName));
    }
  }
  text += escapeHtml(src.slice(last));

  return wrapEmoji(emphasis(text)).replace(PARKED_RE, (_, i: string) => parked[Number(i)]);
}

/**
 * The line that closes a fence opened at `lines[i]`, or -1. A fence only
 * counts once it closes; an unclosed one is plain text.
 */
function fenceEnd(lines: string[], i: number): number {
  if (!/^```[\w-]*\s*$/.test(lines[i])) return -1;
  for (let end = i + 1; end < lines.length; end++) {
    if (/^```\s*$/.test(lines[end])) return end;
  }
  return -1;
}

/**
 * The first url the rendered message actually links to - a masked link's
 * target, or a bare url trimmed as it is rendered - for the link preview. A
 * url written as code is not a link, so it gets no preview either.
 */
export function firstLinkedUrl(content: string): string | null {
  if (typeof content !== "string") return null;
  const lines = content.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const end = fenceEnd(lines, i);
    if (end !== -1) {
      i = end;
      continue;
    }
    for (const [, , , , , href, bare] of lines[i].matchAll(SPAN_RE)) {
      if (href !== undefined) return href;
      if (bare !== undefined) return trimUrl(bare).url;
    }
  }
  return null;
}

/**
 * The whole message. The container keeps `white-space: pre-wrap`, so plain
 * lines keep their newlines; a heading, a list or a code block already breaks
 * the line, so the newline beside one is dropped.
 */
export function renderMessageMarkdown(content: string, resolveName: ResolveName): string {
  // Content is a claim about a JSON.parse result: a peer can send a number.
  if (typeof content !== "string") return "";
  const lines = content.split("\n");
  const out: { block: boolean; html: string }[] = [];
  let items: string[] = [];
  const flushList = () => {
    if (!items.length) return;
    out.push({ block: true, html: `<ul class="${LIST_CLASS}">${items.join("")}</ul>` });
    items = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const end = fenceEnd(lines, i);
    if (end !== -1) {
      flushList();
      const body = code(lines.slice(i + 1, end).join("\n"), resolveName);
      out.push({ block: true, html: `<pre class="${PRE_CLASS}"><code>${body}</code></pre>` });
      i = end;
      continue;
    }

    const item = /^\s*[-*]\s+(\S.*)$/.exec(line);
    if (item) {
      items.push(`<li>${inline(item[1], resolveName)}</li>`);
      continue;
    }
    flushList();

    const heading = /^(#{1,3})\s+(\S.*)$/.exec(line);
    if (heading) {
      const level = heading[1].length;
      out.push({
        block: true,
        html: `<h${level} class="${HEADING_CLASS[level]}">${inline(heading[2], resolveName)}</h${level}>`,
      });
      continue;
    }
    out.push({ block: false, html: inline(line, resolveName) });
  }
  flushList();

  let html = "";
  for (let k = 0; k < out.length; k++) {
    if (k > 0 && !out[k].block && !out[k - 1].block) html += "\n";
    html += out[k].html;
  }
  return html;
}
