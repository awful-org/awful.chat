/**
 * The AI prompt pack: everything a model needs to explain WHY a capture
 * failed, in the order it needs it — the schema and vocabulary before the
 * data, the deterministic findings before the raw evidence, and the raw
 * evidence last so the model's own reasoning is grounded in it.
 *
 * PRIVACY. This is the dashboard's own output, so it is bound by the same
 * rule as a client bundle: no room code, no `did:key:`. A bundle never
 * carries either, but `logs.ts` parses raw SFU/relay logs that DO contain
 * room codes and peer ids in clear, and a log-derived `MergedEvent` can end
 * up with a room code sitting in its `d` bag (e.g. `d.roomRaw`) before this
 * module ever sees it.
 *
 * Two layers, in this order:
 *  1. BY KEY. `logs.ts` puts a room code lifted verbatim out of a log line in
 *     `d.roomRaw` and nowhere else, so that key's value is replaced wholesale -
 *     the same thing `maskValue` in `sources.svelte.ts` does for the
 *     interactive views. This is the layer that has to hold: the room code
 *     format has already changed once (16 hex, then 13 Crockford base32), and
 *     a shape-matching regex that trails the format lets every code minted
 *     since the change through in silence.
 *  2. BY SHAPE. Every string that reaches the rendered markdown - every
 *     `d`/`detail` value, every rule sentence - still goes through
 *     `sanitizeString`, which strips a `did:key:...` token and both room code
 *     shapes (see `redact.ts` in the frontend's telemetry module).
 *
 * This is defense in depth: it is not this module's job to know which upstream
 * parser might slip, only to guarantee its own output never contains the two
 * forbidden shapes.
 */

import type { Capture, MergedEvent } from "./merge";
import type { Finding } from "./findings";
import { RULES } from "./rules";
import { foldTopology, type Topology } from "./topology";

export interface PromptPack {
  markdown: string;
  tokensEstimate: number;
}

/** Rendered sections, in the order a model needs them. */
const SECTION_INTRO = "## 1. What awful.chat is";
const SECTION_SCHEMA = "## 2. Event schema and kinds present";
const SECTION_FINDINGS = "## 3. Findings";
const SECTION_TOPOLOGY = "## 4. Topology";
const SECTION_EVENTS = "## 5. Event window";
const SECTION_QUESTION = "## 6. Question";

export function buildPromptPack(
  c: Capture,
  findings: Finding[],
  opts?: { maxEvents?: number },
): PromptPack {
  const maxEvents = opts?.maxEvents ?? 400;
  const blocking = firstBlockingFinding(findings, c);
  const markdown = [
    sectionIntro(),
    sectionSchema(c),
    sectionFindings(findings),
    sectionTopology(c, blocking),
    sectionEventWindow(c, blocking, maxEvents),
    sectionQuestion(),
  ].join("\n\n");
  // Documented approximation: ~4 characters per token, the common rule of
  // thumb for English/markdown text. This is a token-budget estimate for the
  // UI, not a tokenizer, so it never counts model-specific tokens exactly.
  const tokensEstimate = Math.ceil(markdown.length / 4);
  return { markdown, tokensEstimate };
}

// ---------------------------------------------------------------------------
// Redaction - see the module comment. Applied to every string this module
// emits that did not come from a literal written in this file.
// ---------------------------------------------------------------------------

const DID_RE = /did:key:[A-Za-z0-9]+/gi;
/**
 * Both room code shapes: 13 characters of the Crockford base32 alphabet
 * (`room-code.ts`, 65 bits, minted since 2026-08-28) and the 16+ hex
 * characters of the codes before it. Shape matching is the SECOND layer -
 * `RAW_ROOM_KEYS` below is the one that does not go stale when the format
 * moves again.
 */
const ROOM_CODE_RE = /\b(?:[0-9a-fA-F]{16,}|[0-9ABCDEFGHJKMNPQRSTVWXYZ]{13})\b/g;

/**
 * `d` keys `logs.ts` fills with raw room text (see its module comment: a room
 * code found in a log line goes into `d.roomRaw` ONLY). Their values never
 * reach the pack, whatever shape the code happens to have this year.
 */
const RAW_ROOM_KEYS = new Set(["roomRaw"]);

const REDACTED_ROOM = "[redacted-room]";

function sanitizeString(s: string): string {
  return s.replace(DID_RE, "[redacted-did]").replace(ROOM_CODE_RE, REDACTED_ROOM);
}

function formatDetail(d?: Record<string, string | number | boolean | null> | null): string {
  if (!d || Object.keys(d).length === 0) return "{}";
  const sanitized: Record<string, string | number | boolean | null> = {};
  for (const [k, v] of Object.entries(d)) {
    const key = sanitizeString(k);
    // Held back by key, not by shape. The key itself stays, so the model can
    // still see that the event was about a room.
    sanitized[key] = RAW_ROOM_KEYS.has(k)
      ? REDACTED_ROOM
      : typeof v === "string"
        ? sanitizeString(v)
        : v;
  }
  return JSON.stringify(sanitized);
}

/** Last 8 characters, for a compact human-readable line. Never the join key. */
function shortId(id: string): string {
  return id.length > 8 ? id.slice(-8) : id;
}

// ---------------------------------------------------------------------------
// Section 1 - what awful.chat is
// ---------------------------------------------------------------------------

function sectionIntro(): string {
  return [
    SECTION_INTRO,
    "",
    "awful.chat is a peer-to-peer chat app. Messages, files and voice calls",
    "go directly between peers over libp2p. No server can read their",
    "content. A libp2p relay does two jobs: rendezvous, so peers in one room",
    "can find each other, and circuit relaying, so a peer behind a hard NAT",
    "can still reach another peer. A separate SFU (selective forwarding",
    "unit) routes video and screen-share streams only. Voice never touches",
    "it.",
    "",
    "This pack merges up to three vantage points on one session:",
    "- **client** - what one peer's own browser saw.",
    "- **relay** - what the libp2p relay saw for that peer.",
    "- **sfu** - what the SFU saw for that peer's media session.",
    "",
    "The three vantages can disagree with each other. A finding below can",
    "name a peer, a pair of peers, a room or a vantage. Use the topology",
    "tables and the event window in this pack to see the disagreement.",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Section 2 - schema + kinds present
// ---------------------------------------------------------------------------

function kindsPresent(c: Capture): Array<[string, number]> {
  const counts = new Map<string, number>();
  for (const e of c.timeline) counts.set(e.kind, (counts.get(e.kind) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function sectionSchema(c: Capture): string {
  const counts = kindsPresent(c);
  return [
    SECTION_SCHEMA,
    "",
    "Every event on the wire has this shape:",
    "```ts",
    "interface DiagEvent {",
    "  seq: number;   // 1-based, per session; a gap means events were dropped",
    "  t: number;     // ms since the session start",
    "  kind: DiagKind; // one literal from a closed vocabulary of event names",
    '  sev: "debug" | "info" | "warn" | "error";',
    "  peer: string | null;  // full peerId this event is about, or null",
    '  room: string | null;  // bundle-local ordinal ("r1"); never a room code',
    "  d?: Record<string, string | number | boolean | null>; // flat detail bag",
    "}",
    "```",
    "",
    `Kinds present in this capture (${c.timeline.length} event(s) total):`,
    "```txt",
    ...(counts.length > 0 ? counts.map(([kind, n]) => `${kind}: ${n}`) : ["(no events)"]),
    "```",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Section 3 - findings
// ---------------------------------------------------------------------------

function formatSubject(subject: Finding["subject"]): string {
  const parts: string[] = [];
  if (subject.peer) parts.push(`peer=${shortId(subject.peer)}`);
  if (subject.pair) parts.push(`pair=${subject.pair.map(shortId).join(",")}`);
  if (subject.room) parts.push(`room=${sanitizeString(subject.room)}`);
  if (subject.vantage) parts.push(`vantage=${subject.vantage}`);
  return parts.length > 0 ? parts.join(" ") : "(none)";
}

function sectionFindings(findings: Finding[]): string {
  if (findings.length === 0) {
    return [SECTION_FINDINGS, "", "No findings fired for this capture."].join("\n");
  }
  const lines = [SECTION_FINDINGS];
  for (const f of findings) {
    const rule = RULES[f.id];
    lines.push(
      "",
      `### ${rule.title} (\`${f.id}\`, ${f.severity})`,
      `- meaning: ${sanitizeString(rule.meaning)}`,
      `- remedy: ${sanitizeString(rule.remedy)}`,
      `- aiHint: ${sanitizeString(rule.aiHint)}`,
      `- subject: ${formatSubject(f.subject)}`,
      `- evidence: ${f.evidence.length} event(s), timeline indices [${f.evidence.join(", ")}]`,
      `- detail: ${formatDetail(f.detail)}`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Section 4 - topology at the first blocking finding, and at the end
// ---------------------------------------------------------------------------

function firstBlockingFinding(findings: Finding[], c: Capture): Finding | undefined {
  return findings.find(
    (f) => f.severity === "block" && f.evidence.length > 0 && f.evidence[0] < c.timeline.length,
  );
}

function renderTopologyTable(topo: Topology): string {
  const lines: string[] = [];
  lines.push(`self: ${shortId(topo.self)}`);
  lines.push(
    topo.relay
      ? `relay: ${shortId(topo.relay.peerId)} connected=${topo.relay.connected} reserved=${topo.relay.reserved}`
      : "relay: (none)",
  );
  lines.push(
    topo.sfu
      ? `sfu: ${topo.sfu.host} connected=${topo.sfu.connected} roomPeerCount=${topo.sfu.roomPeerCount ?? "?"}`
      : "sfu: (none)",
  );
  lines.push("");
  const ids = topo.nodes.map((n) => n.peerId);
  if (ids.length === 0) {
    lines.push("(no peers)");
    return lines.join("\n");
  }
  lines.push(["from \\ to", ...ids.map(shortId)].join(" | "));
  for (const from of ids) {
    const row = [shortId(from)];
    for (const to of ids) {
      if (from === to) {
        row.push("-");
        continue;
      }
      const link = topo.links.find((l) => l.from === from && l.to === to);
      row.push(link ? link.state : "none");
    }
    lines.push(row.join(" | "));
  }
  return lines.join("\n");
}

function sectionTopology(c: Capture, blocking: Finding | undefined): string {
  const lines = [
    SECTION_TOPOLOGY,
    "",
    "Peer, relay and observer ids below are shortened to their last 8",
    "characters for a readable table; they are not ambiguous within one",
    "capture.",
    "",
    "### At the first blocking finding",
  ];
  if (blocking) {
    const at = c.timeline[blocking.evidence[0]].at;
    lines.push("```txt", renderTopologyTable(foldTopology(c, at)), "```");
  } else {
    lines.push("(no blocking finding in this capture)");
  }
  lines.push("", "### At the end of the capture", "```txt", renderTopologyTable(foldTopology(c, c.window.to)), "```");
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Section 5 - the event window
// ---------------------------------------------------------------------------

function formatEventLine(e: MergedEvent): string {
  const iso = new Date(e.at).toISOString();
  const peer = e.peer ? shortId(e.peer) : "-";
  return `${iso} observer=${shortId(e.observer)} kind=${e.kind} sev=${e.sev} peer=${peer} d=${formatDetail(e.d)}`;
}

/** [start, end) of `timeline` to render, centred on `blocking`'s evidence when present. */
function eventWindowBounds(
  timelineLength: number,
  blocking: Finding | undefined,
  maxEvents: number,
): { start: number; end: number } {
  if (!blocking) {
    const end = timelineLength;
    return { start: Math.max(0, end - maxEvents), end };
  }
  const anchor = blocking.evidence[0];
  const radius = Math.floor(maxEvents / 2);
  let start = Math.max(0, anchor - radius);
  let end = Math.min(timelineLength, start + maxEvents);
  start = Math.max(0, end - maxEvents);
  return { start, end };
}

function sectionEventWindow(
  c: Capture,
  blocking: Finding | undefined,
  maxEvents: number,
): string {
  const { start, end } = eventWindowBounds(c.timeline.length, blocking, maxEvents);
  const slice = c.timeline.slice(start, end);
  return [
    SECTION_EVENTS,
    "",
    `${slice.length} of ${c.timeline.length} event(s), oldest first. Observer and peer`,
    "ids are shortened to their last 8 characters.",
    "```txt",
    ...(slice.length > 0 ? slice.map(formatEventLine) : ["(no events)"]),
    "```",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// Section 6 - the question
// ---------------------------------------------------------------------------

function sectionQuestion(): string {
  return [
    SECTION_QUESTION,
    "",
    "Explain the causal chain, name the single root cause, and say what",
    "evidence would confirm or refute it.",
  ].join("\n");
}
