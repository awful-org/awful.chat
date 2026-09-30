import { MessageType, type Message } from "$lib/types/message";
import { getManifest } from "$lib/plugins/registry";

/**
 * Extract displayable text for a message when it is quoted in a reply.
 *
 * Returns either the message text (trimmed to 160 chars) or a type-appropriate
 * placeholder like [image] or [file] when the message has no readable text.
 * Used when building reply snapshots and rendering quoted text so the preview
 * and sent result always agree on what appears in the quote.
 */
/**
 * How much of a quoted message a reply row strips for display. The row shows
 * one line and truncates itself; stripping a 64 KB message on every render
 * for that line was the whole message's worth of work, and this is still far
 * more than any line shows. Cut markup-safe like the snapshot, so a long code
 * block cannot leave a raw fence on show.
 */
export const QUOTE_SHOWN_CHARS = 2000;

export function getQuotableText(msg: Message, limit = 160): string {
  // A plugin card's content is its JSON payload - quoting that raw showed
  // {"pluginId":... in the reply. Name the plugin instead.
  if (msg.type === MessageType.PluginCard) {
    let name = "plugin";
    try {
      const parsed = JSON.parse(msg.content) as { pluginId?: string };
      if (typeof parsed.pluginId === "string" && parsed.pluginId)
        name = getManifest(parsed.pluginId)?.name ?? parsed.pluginId;
    } catch {
      // Malformed card: the generic placeholder stands.
    }
    return `[Plugin: ${name}]`;
  }

  // Text quotes as itself; a bare image link (the GIF picker) does not.
  if (msg.content && !isUrlLike(msg.content)) {
    return trimContent(msg.content, limit);
  }

  // Content is empty or is a URL. Check message type for appropriate placeholder.
  if (msg.type === MessageType.File && msg.meta?.files?.[0]) {
    // File attachment - use filename if available, else generic placeholder
    return `[${msg.meta.files[0].filename || "file"}]`;
  }

  // Default placeholder for image-only or empty messages (GIF picker sends URL content)
  return "[image]";
}

/**
 * The spans markdown.ts reads whole: a fence (or a one-line ```code```), a
 * code span, a [label](url), a ||spoiler|| - cut open, its hidden text would
 * show in the quote.
 */
const SPAN_RE = /```[^]*?```|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s()<>"]+\)|(?<!\|)\|\|(?!\|)[^\n]*?(?<!\|)\|\|(?!\|)/g;

/**
 * Trim content to 160 characters with ellipsis if needed. Matches the snapshot
 * construction logic used when building reply snapshots on send.
 *
 * The snapshot is markdown, shown stripped (markdown.ts), so a cut through a
 * span the full text holds - a fence, a code span, a [label](url), a
 * spoiler - backs off
 * to before it rather than leave its half on show as raw syntax. Only spans
 * that really close count: a lone "`" or "[" is text in the full message too,
 * and cutting back to it dropped everything after it. A message that opens
 * with a fence, a code span or a spoiler has nothing before it to keep, so
 * that one is closed after the cut instead of quoted as a bare "...".
 */
export function trimContent(text: string, limit = 160): string {
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit - 3);
  for (const m of text.matchAll(SPAN_RE)) {
    const start = m.index ?? 0;
    if (start >= cut.length) break;
    if (start + m[0].length <= cut.length) continue;
    const before = cut.slice(0, start).trimEnd();
    if (before || m[0][0] === "[") return `${before}...`;
    const tick = m[0].startsWith("```") ? "```" : m[0].startsWith("||") ? "||" : "`";
    return `${cut.trimEnd()}...${tick === "```" && cut.includes("\n") ? "\n" : ""}${tick}`;
  }
  return `${cut.trimEnd()}...`;
}

/**
 * A bare image link is what the GIF picker sends, and MsgRender renders it as
 * the picture rather than the text (same rule as its isGifUrl: the whole
 * message is the URL and the pathname ends in .gif/.webp). Any other link is
 * ordinary text and quotes as itself - a shared article is not an "[image]".
 */
function isUrlLike(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
    return false;
  }
  try {
    return /\.(gif|webp)$/i.test(new URL(trimmed).pathname);
  } catch {
    return false;
  }
}
