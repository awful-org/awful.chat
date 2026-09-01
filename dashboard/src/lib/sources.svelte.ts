/**
 * The console's only reactive state.
 *
 * The split this module enforces is the same one the chat app uses for call
 * quality: `call-quality.ts` is pure, `call-peer-quality.svelte.ts` holds the
 * runes, `CallStatus.svelte` renders. Here `analysis/*.ts` is pure, this file
 * holds every rune, and a `.svelte` file renders and nothing else.
 *
 * Two rules keep it fast and honest.
 *
 * 1. HEAVY PAYLOADS STAY OUT OF `$state`. A bundle holds up to 4096 events. A
 *    rune proxy over that array would proxy every event on every read, so the
 *    payloads live in a plain `Map` and a `revision` counter marks them dirty.
 *    Only the light per-file metadata is reactive, because that is what the
 *    Sources view renders.
 * 2. THE RELAY ADMIN TOKEN LIVES IN MEMORY ONLY. It is never written to
 *    localStorage, never put in a URL and never logged. A reload loses it, and
 *    that is the intended cost: this console reads a production relay.
 *
 * An SFU log carries room codes in clear (see `analysis/logs.ts`). Those stay
 * in this process. Nothing here writes a room code into an export or a prompt.
 */

import { DIAG_SCHEMA_VERSION } from "./schema";
import type { ClientBundle, DiagSeverity, SfuSnapshot } from "./schema";
import { MAX_ACCEPTABLE_SKEW_MS, mergeSources } from "./analysis/merge";
import type {
  Capture,
  MergedEvent,
  PeerSummary,
  VantageKind,
} from "./analysis/merge";
import {
  foldTopology,
  primaryObserver,
  topologyKeyframes,
  vantageKinds,
} from "./analysis/topology";
import type { LinkState, Topology, TopologyLink } from "./analysis/topology";
import { runFindings } from "./analysis/findings";
import type { Finding } from "./analysis/findings";
import {
  parseConsoleLog,
  parseRelayLog,
  parseSfuLog,
  parseSfuTelemetry,
  resolveSuffix,
} from "./analysis/logs";
import type { ParsedLog } from "./analysis/logs";
import { buildPromptPack } from "./analysis/prompt";
import type { PromptPack } from "./analysis/prompt";
import { getBundle, listBundles, normalizeBase } from "./relay-client";
import type { RelayBundleRef } from "./relay-client";

// ---------------------------------------------------------------------------
// Shape
// ---------------------------------------------------------------------------

export type Tab =
  | "sources"
  | "sessions"
  | "findings"
  | "timeline"
  | "topology"
  | "matrix"
  | "peers"
  | "logs"
  | "ai";

/**
 * The workflow order: load, pick a capture, read the verdict, then dig, then
 * check the parse, then hand the pack to a model.
 */
export const TABS: ReadonlyArray<{ id: Tab; label: string }> = [
  { id: "sources", label: "Sources" },
  { id: "sessions", label: "Sessions" },
  { id: "findings", label: "Findings" },
  { id: "timeline", label: "Timeline" },
  { id: "topology", label: "Topology" },
  { id: "matrix", label: "Matrix" },
  { id: "peers", label: "Peers" },
  { id: "logs", label: "Logs" },
  { id: "ai", label: "AI" },
];

export type LogParser = "sfu" | "relay" | "console";

/**
 * `sfu` runs BOTH SFU parsers over one text. A real `docker logs sfu` file
 * carries the structured `[sfu-telemetry]` lines beside the free-form `[sfu]`
 * lines, and `parseSfuLog` skips the structured ones, so the two parsers
 * cover one file without a duplicate or a double-counted line.
 */
export const LOG_PARSERS: ReadonlyArray<{ id: LogParser; label: string }> = [
  { id: "sfu", label: "sfu container log" },
  { id: "relay", label: "relay container log" },
  { id: "console", label: "browser console" },
];

export type FileRole = "bundle" | "log" | "rejected";

/** The light half of a loaded file. This is what the Sources view renders. */
export interface FileMeta {
  id: string;
  name: string;
  /** Unique per workspace, so `MergedEvent.source` names exactly one file. */
  source: string;
  bytes: number;
  role: FileRole;
  /** The vantage a bundle carries, or "log". */
  vantage: VantageKind | null;
  /** The bundle's own peerId, or the first peerId a log resolved. */
  observer: string;
  eventCount: number;
  /** Set for a log. */
  parser: LogParser | null;
  /** Log lines the parser did not recognise. They survive as `raw` events. */
  unmatched: number;
  warnings: string[];
  /** Why the file is unusable. Reported, never dropped. */
  error: string | null;
  /** True when the relay's admin route supplied it. */
  fromRelay: boolean;
}

export interface Filter {
  /** The lowest severity a row must have. "debug" shows every row. */
  minSev: DiagSeverity;
  /** Matched against the start of `DiagEvent.kind`. */
  kindPrefix: string;
  /** A full peerId, matched against `peer` or `observer`. */
  peer: string;
  from: number | null;
  to: number | null;
}

const DEFAULT_FILTER: Filter = {
  minSev: "debug",
  kindPrefix: "",
  peer: "",
  from: null,
  to: null,
};

export interface TimelineRow {
  /** Index into `capture.timeline`. A finding's evidence names this number. */
  i: number;
  e: MergedEvent;
  lane: string;
}

export interface Lane {
  key: string;
  label: string;
  kind: VantageKind;
}

export interface CaptureRow {
  capture: Capture;
  kinds: VantageKind[];
  peerCount: number;
  counts: FindingCounts;
}

export interface FindingCounts {
  block: number;
  warn: number;
  info: number;
}

const SEV_RANK: Readonly<Record<DiagSeverity, number>> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

// ---------------------------------------------------------------------------
// Raw state
// ---------------------------------------------------------------------------

interface Payload {
  bundle: ClientBundle | null;
  parsed: ParsedLog | null;
  /** The raw text, so the Logs view can show a mis-parse beside its source. */
  text: string;
}

/** Deliberately not `$state`: see rule 1 at the top of this file. */
const payloads = new Map<string, Payload>();

const files = $state<FileMeta[]>([]);
/** Bumped whenever `payloads` changes. `workspace` reads it to stay correct. */
let revision = $state(0);

let tab = $state<Tab>("sources");
let selectedCaptureId = $state<string | null>(null);
let selectedPeerId = $state<string | null>(null);
/** Null means "the end of the capture window". */
let scrubAt = $state<number | null>(null);
/** Index into the filtered rows, not into the timeline. */
let cursor = $state<number | null>(null);
const filter = $state<Filter>({ ...DEFAULT_FILTER });

const relay = $state({
  apiBase: "",
  /** Memory only. Never persisted, never in a URL. */
  token: "",
  busy: false,
  /** The last outcome, in the operator's words. */
  message: "",
  ok: false,
  bundles: [] as RelayBundleRef[],
});

const ai = $state({
  /** Memory only, like the relay token. */
  endpoint: "",
  key: "",
  model: "",
  busy: false,
  response: "",
  error: "",
  maxEvents: 400,
});

let nextId = 1;

// ---------------------------------------------------------------------------
// Derived
// ---------------------------------------------------------------------------

/**
 * The loaded inputs, with every log peer suffix resolved.
 *
 * The relay's `short()` prints only the last 8 characters of a peerId, and a
 * log parser gets no peer list, so it records `d.peerSuffix` and leaves `peer`
 * null. This is the one place that knows both halves, so this is where the
 * resolution belongs. It is additive: an ambiguous suffix stays unattributed
 * and becomes a warning, because a wrong attribution is worse than a gap.
 */
const inputs = $derived.by(() => {
  // Read the marker so a payload change invalidates this.
  void revision;
  const bundles: Array<{ bundle: ClientBundle; source: string }> = [];
  const raw: MergedEvent[] = [];
  for (const f of files) {
    const p = payloads.get(f.id);
    if (!p) continue;
    if (f.role === "bundle" && p.bundle) {
      bundles.push({ bundle: p.bundle, source: f.source });
    }
    if (f.role === "log" && p.parsed) raw.push(...p.parsed.events);
  }

  const known = new Set<string>();
  for (const { bundle } of bundles) {
    known.add(bundle.self.peerId);
    for (const p of bundle.peers) known.add(p.peerId);
    for (const e of bundle.events) {
      if (e.peer) known.add(e.peer);
    }
    const view = bundle.relayView;
    if (!view) continue;
    known.add(view.relayPeerId);
    known.add(view.observedPeerId);
    for (const room of view.rooms) for (const m of room.members) known.add(m);
  }
  const ids = [...known];

  const ambiguous = new Set<string>();
  const unresolved = new Set<string>();
  const events = raw.map((e) => {
    const suffix = e.peer === null ? e.d?.peerSuffix : undefined;
    if (typeof suffix !== "string" || suffix === "") return e;
    const hit = resolveSuffix(suffix, ids);
    if (hit.peerId !== null) return { ...e, peer: hit.peerId };
    if (hit.ambiguous) ambiguous.add(suffix);
    else unresolved.add(suffix);
    return e;
  });

  const warnings: string[] = [];
  for (const s of ambiguous) {
    warnings.push(
      `The log suffix …${s} matches more than one loaded peer, so it stays unattributed.`
    );
  }
  if (unresolved.size > 0) {
    warnings.push(
      `${unresolved.size} log peer suffix(es) match no loaded bundle: …${[...unresolved].slice(0, 6).join(", …")}. Load that peer's bundle to attribute them.`
    );
  }
  return { bundles, events, warnings };
});

const workspace = $derived.by(() => mergeSources(inputs.bundles, inputs.events));

const captureRows = $derived.by<CaptureRow[]>(() =>
  workspace.captures.map((capture) => {
    const servers = serversOf(capture);
    return {
      capture,
      kinds: vantageKinds(capture),
      peerCount: [...capture.peers.keys()].filter((id) => !servers.has(id)).length,
      counts: countFindings(runFindings(capture)),
    };
  })
);

const capture = $derived.by<Capture | null>(() => {
  const list = workspace.captures;
  if (list.length === 0) return null;
  const hit = list.find((c) => c.id === selectedCaptureId);
  return hit ?? list[0];
});

const findings = $derived.by<Finding[]>(() =>
  capture ? runFindings(capture) : []
);

const findingCounts = $derived.by(() => countFindings(findings));

const at = $derived.by(() => {
  if (!capture) return 0;
  if (scrubAt === null) return capture.window.to;
  return Math.min(Math.max(scrubAt, capture.window.from), capture.window.to);
});

const lanes = $derived.by<Lane[]>(() => {
  if (!capture) return [];
  const out: Lane[] = [];
  const seen = new Set<string>();
  for (const v of capture.vantages) {
    const key = laneKeyOfVantage(v.kind, v.observer, v.source);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ key, kind: v.kind, label: laneLabel(v.kind, v.observer, v.source) });
  }
  // Clients first, then the relay, then the SFU and other logs.
  const rank: Record<VantageKind, number> = { client: 0, relay: 1, sfu: 2, log: 3 };
  return out.sort((a, b) => rank[a.kind] - rank[b.kind] || a.label.localeCompare(b.label));
});

const rows = $derived.by<TimelineRow[]>(() => {
  if (!capture) return [];
  const min = SEV_RANK[filter.minSev];
  const prefix = filter.kindPrefix.trim();
  const peer = filter.peer.trim();
  const out: TimelineRow[] = [];
  const timeline = capture.timeline;
  for (let i = 0; i < timeline.length; i++) {
    const e = timeline[i];
    if (SEV_RANK[e.sev] < min) continue;
    if (prefix !== "" && !e.kind.startsWith(prefix)) continue;
    if (peer !== "" && e.peer !== peer && e.observer !== peer) continue;
    if (filter.from !== null && e.at < filter.from) continue;
    if (filter.to !== null && e.at > filter.to) continue;
    out.push({ i, e, lane: laneKeyOf(e) });
  }
  return out;
});

const topology = $derived.by<Topology | null>(() =>
  capture ? foldTopology(capture, at) : null
);

const keyframes = $derived.by<number[]>(() =>
  capture ? topologyKeyframes(capture) : []
);

const logFiles = $derived.by(() => files.filter((f) => f.role === "log"));

const promptPack = $derived.by<PromptPack | null>(() =>
  capture ? buildPromptPack(capture, findings, { maxEvents: ai.maxEvents }) : null
);

/** Empty rather than absent, so a view never needs a null check for a set. */
const NO_SERVERS: ReadonlySet<string> = new Set<string>();

const serverIds = $derived.by<ReadonlySet<string>>(() =>
  capture ? serversOf(capture) : NO_SERVERS
);

const peerList = $derived.by<PeerSummary[]>(() => {
  if (!capture) return [];
  return [...capture.peers.values()]
    .filter((p) => !serverIds.has(p.peerId))
    .sort(
      (a, b) =>
        Number(b.hasVantage) - Number(a.hasVantage) ||
        a.firstSeen - b.firstSeen ||
        a.peerId.localeCompare(b.peerId)
    );
});

const selectedPeer = $derived.by<PeerSummary | null>(() => {
  const list = peerList;
  if (list.length === 0) return null;
  const hit = list.find((p) => p.peerId === selectedPeerId);
  return hit ?? list[0];
});

// ---------------------------------------------------------------------------
// The read surface
// ---------------------------------------------------------------------------

/**
 * Getters, because Svelte refuses a direct `export` of reassigned rune state.
 * A template that reads `app.rows` still tracks every dependency behind it.
 */
export const app = {
  get tab(): Tab {
    return tab;
  },
  get files(): FileMeta[] {
    return files;
  },
  get logFiles(): FileMeta[] {
    return logFiles;
  },
  get warnings(): string[] {
    return [...workspace.warnings, ...inputs.warnings];
  },
  get captures(): Capture[] {
    return workspace.captures;
  },
  get captureRows(): CaptureRow[] {
    return captureRows;
  },
  get capture(): Capture | null {
    return capture;
  },
  get findings(): Finding[] {
    return findings;
  },
  get findingCounts(): FindingCounts {
    return findingCounts;
  },
  get at(): number {
    return at;
  },
  get lanes(): Lane[] {
    return lanes;
  },
  get rows(): TimelineRow[] {
    return rows;
  },
  get cursor(): number | null {
    return cursor;
  },
  get filter(): Filter {
    return filter;
  },
  get topology(): Topology | null {
    return topology;
  },
  get keyframes(): number[] {
    return keyframes;
  },
  get peers(): PeerSummary[] {
    return peerList;
  },
  /** Ids to exclude from any peer view: the relay, the SFU, a log's own name. */
  get serverIds(): ReadonlySet<string> {
    return serverIds;
  },
  get selectedPeer(): PeerSummary | null {
    return selectedPeer;
  },
  get relay() {
    return relay;
  },
  get ai() {
    return ai;
  },
  get promptPack(): PromptPack | null {
    return promptPack;
  },
  /** True when the offset solve left a residual big enough to distrust. */
  get skewSuspect(): boolean {
    return (capture?.maxSkewResidualMs ?? 0) > MAX_ACCEPTABLE_SKEW_MS;
  },
  get primaryObserver(): string {
    return capture ? primaryObserver(capture) : "";
  },
};

// ---------------------------------------------------------------------------
// Mutators
// ---------------------------------------------------------------------------

export function goTo(next: Tab): void {
  tab = next;
}

export function selectCapture(id: string): void {
  selectedCaptureId = id;
  scrubAt = null;
  cursor = null;
  selectedPeerId = null;
}

export function scrubTo(next: number): void {
  scrubAt = next;
}

export function selectPeer(peerId: string): void {
  selectedPeerId = peerId;
}

export function setFilter(patch: Partial<Filter>): void {
  Object.assign(filter, patch);
  cursor = null;
}

export function resetFilter(): void {
  Object.assign(filter, DEFAULT_FILTER);
}

export function setParser(id: string, parser: LogParser): void {
  const meta = files.find((f) => f.id === id);
  const payload = payloads.get(id);
  if (!meta || !payload || meta.role !== "log") return;
  applyParser(meta, payload, parser);
  revision++;
}

export function removeFile(id: string): void {
  const at = files.findIndex((f) => f.id === id);
  if (at < 0) return;
  files.splice(at, 1);
  payloads.delete(id);
  revision++;
}

/** Drops every loaded file. The relay form survives, so a re-list is one click. */
export function clearAll(): void {
  files.length = 0;
  payloads.clear();
  relay.bundles = [];
  relay.message = "";
  relay.ok = false;
  selectedCaptureId = null;
  selectedPeerId = null;
  scrubAt = null;
  cursor = null;
  Object.assign(filter, DEFAULT_FILTER);
  revision++;
}

/**
 * Read every file and classify it. A file that is not a usable bundle stays in
 * the list with an `error`, because a silent drop hides the real problem.
 */
export async function loadFiles(list: File[]): Promise<void> {
  for (const file of list) {
    let text = "";
    try {
      text = await file.text();
    } catch {
      push(
        meta(file.name, file.size, "rejected", {
          error: "The browser could not read this file.",
        }),
        { bundle: null, parsed: null, text: "" }
      );
      continue;
    }
    ingest(file.name, file.size, text, false);
  }
  revision++;
  autoSelect();
}

/** List the relay's stored bundles. The token stays in memory. */
export async function loadFromRelay(): Promise<void> {
  relay.busy = true;
  relay.message = "";
  const res = await listBundles(relay.apiBase, relay.token);
  relay.busy = false;
  relay.ok = res.ok;
  if (!res.ok) {
    relay.bundles = [];
    relay.message = res.message;
    return;
  }
  relay.bundles = res.value;
  relay.apiBase = normalizeBase(relay.apiBase);
  relay.message =
    res.value.length === 0
      ? "The relay has no stored bundles."
      : `The relay holds ${res.value.length} bundle(s).`;
}

/** Fetch one listed bundle into the workspace. */
export async function loadRelayBundle(ref: RelayBundleRef): Promise<void> {
  relay.busy = true;
  const res = await getBundle(relay.apiBase, relay.token, ref.id);
  relay.busy = false;
  if (!res.ok) {
    relay.ok = false;
    relay.message = `${ref.id}: ${res.message}`;
    return;
  }
  const text = JSON.stringify(res.value);
  ingest(`relay:${ref.id}`, text.length, text, true);
  relay.message = `Loaded ${ref.id}.`;
  revision++;
  autoSelect();
}

// ---------------------------------------------------------------------------
// Timeline navigation
// ---------------------------------------------------------------------------

/** `j` and `k`. The scrubber follows, so the Topology view tracks the cursor. */
export function stepCursor(delta: number): void {
  const list = rows;
  if (list.length === 0) return;
  const from = cursor === null ? (delta > 0 ? -1 : list.length) : cursor;
  const next = Math.min(Math.max(from + delta, 0), list.length - 1);
  setCursor(next);
}

export function setCursor(index: number): void {
  const list = rows;
  if (index < 0 || index >= list.length) return;
  cursor = index;
  scrubAt = list[index].e.at;
}

/**
 * Jump to a timeline index a finding named. When the filter hides that event
 * the filter is reset, because evidence must always be reachable.
 */
export function focusTimelineIndex(i: number): void {
  let hit = rows.findIndex((r) => r.i === i);
  if (hit < 0) {
    resetFilter();
    hit = rows.findIndex((r) => r.i === i);
  }
  if (hit < 0) return;
  setCursor(hit);
  tab = "timeline";
}

/** `f`. The next piece of evidence after the cursor, in timeline order. */
export function nextEvidence(): void {
  const marks = evidenceIndices();
  if (marks.length === 0) return;
  const here = cursor === null ? -1 : rows[cursor].i;
  const next = marks.find((i) => i > here) ?? marks[0];
  focusTimelineIndex(next);
}

/** Every timeline index any finding cites, ascending and without duplicates. */
export function evidenceIndices(): number[] {
  const set = new Set<number>();
  for (const f of findings) for (const i of f.evidence) set.add(i);
  return [...set].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// Queries the views need
// ---------------------------------------------------------------------------

/**
 * The raw text a log file carried, beside the events its parser produced. The
 * Logs view shows both, so a mis-parse is visible instead of silent.
 *
 * An SFU log holds room codes in clear. This text stays in the process: the
 * prompt pack and every export are built from the capture, never from here.
 */
export function logPayload(id: string): { text: string; parsed: ParsedLog } | null {
  const p = payloads.get(id);
  if (!p?.parsed) return null;
  return { text: p.text, parsed: p.parsed };
}

/**
 * The merged timeline index of a parsed event. The merge re-wraps every event,
 * so identity is lost and `(source, seq, at)` is the key that survives.
 */
export function timelineIndexOf(source: string, seq: number, at: number): number {
  if (!capture) return -1;
  return capture.timeline.findIndex(
    (e) => e.source === source && e.seq === seq && e.at === at
  );
}

/** The link the observer `from` held toward `to` at the scrubbed instant. */
export function linkAt(from: string, to: string): TopologyLink | null {
  const t = topology;
  if (!t) return null;
  return t.links.find((l) => l.from === from && l.to === to) ?? null;
}

/** Observers with a vantage of their own. Only these can disagree. */
export function observersWithVantage(): string[] {
  if (!capture) return [];
  return capture.vantages.filter((v) => v.kind === "client").map((v) => v.observer);
}

/** Every event about one peer, oldest first, with its timeline index. */
export function eventsForPeer(peerId: string): TimelineRow[] {
  if (!capture) return [];
  const out: TimelineRow[] = [];
  capture.timeline.forEach((e, i) => {
    if (e.peer === peerId || e.observer === peerId) {
      out.push({ i, e, lane: laneKeyOf(e) });
    }
  });
  return out;
}

/** The `counters` series an observer emitted. Only an observer has counters. */
export function counterSeries(peerId: string): Array<{ at: number; d: Record<string, string | number | boolean | null> }> {
  if (!capture) return [];
  const out: Array<{ at: number; d: Record<string, string | number | boolean | null> }> = [];
  for (const e of capture.timeline) {
    if (e.kind === "counters" && e.observer === peerId && e.d) {
      out.push({ at: e.at, d: e.d });
    }
  }
  return out;
}

/** The round-trip series toward one peer. A lost probe records `ms: null`. */
export function rttSeries(peerId: string): Array<{ at: number; ms: number | null }> {
  if (!capture) return [];
  const out: Array<{ at: number; ms: number | null }> = [];
  for (const e of capture.timeline) {
    if (e.kind !== "peer.rtt" || e.peer !== peerId) continue;
    const raw = e.d?.ms;
    out.push({ at: e.at, ms: typeof raw === "number" ? raw : null });
  }
  return out;
}

/** The SFU snapshots a bundle carried, newest last. */
export function sfuSnapshots(): SfuSnapshot[] {
  if (!capture) return [];
  const out: SfuSnapshot[] = [];
  for (const v of capture.vantages) {
    for (const s of v.bundle?.sfuSnapshots ?? []) out.push(s);
  }
  return out.sort((a, b) => a.takenAt - b.takenAt);
}

export async function sendPromptPack(): Promise<void> {
  const pack = promptPack;
  if (!pack || ai.endpoint.trim() === "") return;
  ai.busy = true;
  ai.error = "";
  ai.response = "";
  try {
    const headers: Record<string, string> = { "content-type": "application/json" };
    if (ai.key.trim() !== "") headers.authorization = `Bearer ${ai.key.trim()}`;
    const res = await fetch(ai.endpoint.trim(), {
      method: "POST",
      headers,
      credentials: "omit",
      body: JSON.stringify({
        model: ai.model.trim() === "" ? undefined : ai.model.trim(),
        messages: [{ role: "user", content: pack.markdown }],
      }),
    });
    const text = await res.text();
    if (!res.ok) {
      ai.error = `The endpoint answered ${res.status}. ${text.slice(0, 400)}`;
      return;
    }
    ai.response = extractReply(text);
  } catch {
    ai.error = "The request failed. Check the endpoint, the scheme and its CORS answer.";
  } finally {
    ai.busy = false;
  }
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function ingest(name: string, bytes: number, text: string, fromRelay: boolean): void {
  if (text.trimStart().startsWith("{")) {
    ingestBundle(name, bytes, text, fromRelay);
    return;
  }
  const m = meta(name, bytes, "log", { fromRelay });
  const payload: Payload = { bundle: null, parsed: null, text };
  applyParser(m, payload, sniffParser(text));
  push(m, payload);
}

function ingestBundle(name: string, bytes: number, text: string, fromRelay: boolean): void {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (err) {
    push(
      meta(name, bytes, "rejected", {
        fromRelay,
        error: `The file starts like JSON but does not parse: ${err instanceof Error ? err.message : String(err)}`,
      }),
      { bundle: null, parsed: null, text }
    );
    return;
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    push(
      meta(name, bytes, "rejected", {
        fromRelay,
        error: "The JSON is not an object, so it is not a bundle.",
      }),
      { bundle: null, parsed: null, text }
    );
    return;
  }
  const b = raw as Partial<ClientBundle>;
  if (b.vantage !== "client" || !Array.isArray(b.events) || !b.self?.peerId) {
    push(
      meta(name, bytes, "rejected", {
        fromRelay,
        error:
          'The JSON is not a client bundle. A bundle has vantage: "client", an events array and self.peerId.',
      }),
      { bundle: null, parsed: null, text }
    );
    return;
  }
  if (b.schemaVersion !== DIAG_SCHEMA_VERSION) {
    push(
      meta(name, bytes, "rejected", {
        fromRelay,
        error: `Schema version ${String(b.schemaVersion)} is not understood. This console reads version ${DIAG_SCHEMA_VERSION}.`,
      }),
      { bundle: null, parsed: null, text }
    );
    return;
  }
  const bundle = raw as ClientBundle;
  const warnings: string[] = [];
  if (bundle.meta?.truncated) warnings.push("The bundle was trimmed for upload.");
  if ((bundle.meta?.dropped ?? 0) > 0) {
    warnings.push(`The ring dropped ${bundle.meta.dropped} event(s).`);
  }
  if (bundle.meta?.faultsActive) {
    warnings.push("Fault injection was active, so every finding is suspect.");
  }
  push(
    meta(name, bytes, "bundle", {
      fromRelay,
      vantage: "client",
      observer: bundle.self.peerId,
      eventCount: bundle.events.length + (bundle.relayView?.events.length ?? 0),
      warnings,
    }),
    { bundle, parsed: null, text }
  );
}

function applyParser(m: FileMeta, payload: Payload, parser: LogParser): void {
  const runs: ParsedLog[] =
    parser === "sfu"
      ? [
          parseSfuTelemetry(payload.text, m.source),
          parseSfuLog(payload.text, m.source),
        ]
      : [
          parser === "relay"
            ? parseRelayLog(payload.text, m.source)
            : parseConsoleLog(payload.text, m.source),
        ];
  const events = runs
    .flatMap((r) => r.events)
    .sort((a, b) => a.at - b.at || a.seq - b.seq);
  const parsed: ParsedLog = {
    events,
    warnings: runs.flatMap((r) => r.warnings),
    unmatched: runs.reduce((sum, r) => sum + r.unmatched, 0),
  };
  payload.parsed = parsed;
  m.parser = parser;
  m.vantage = "log";
  m.eventCount = parsed.events.length;
  m.unmatched = parsed.unmatched;
  m.warnings = parsed.warnings;
  m.observer = parsed.events.find((e) => e.observer !== "")?.observer ?? "";
}

function meta(
  name: string,
  bytes: number,
  role: FileRole,
  extra: Partial<FileMeta> = {}
): FileMeta {
  return {
    id: `f${nextId++}`,
    name,
    source: uniqueSource(name),
    bytes,
    role,
    vantage: null,
    observer: "",
    eventCount: 0,
    parser: null,
    unmatched: 0,
    warnings: [],
    error: null,
    fromRelay: false,
    ...extra,
  };
}

function push(m: FileMeta, payload: Payload): void {
  files.push(m);
  payloads.set(m.id, payload);
}

function uniqueSource(name: string): string {
  let candidate = name;
  let n = 2;
  while (files.some((f) => f.source === candidate)) candidate = `${name}#${n++}`;
  return candidate;
}

/**
 * Select the RICHEST capture, not the newest.
 *
 * A log-only capture often starts later than the bundles it belongs to, so
 * "newest first" would open a one-vantage capture and hide the real incident.
 * The most vantages wins, then the most events, then the newest.
 */
function autoSelect(): void {
  if (selectedCaptureId !== null) return;
  const best = [...workspace.captures].sort(
    (a, b) =>
      b.vantages.length - a.vantages.length ||
      b.timeline.length - a.timeline.length ||
      b.window.from - a.window.from
  )[0];
  if (best) selectedCaptureId = best.id;
}

/**
 * Pick a parser by the tags a log carries. The choice is a guess, so the
 * Sources view exposes it as a select and shows the unmatched count. A wrong
 * guess is then visible and one click from fixed.
 */
export function sniffParser(text: string): LogParser {
  const head = text.slice(0, 200_000);
  if (head.includes("[sfu-telemetry]")) return "sfu";
  const sfu = countMatches(head, /\[(?:sfu|router|worker)\]/g);
  const rv = countMatches(head, /\[(?:rv|relay|http|turn|mailbox)\]/g);
  if (sfu === 0 && rv === 0) return "console";
  return sfu > rv ? "sfu" : "relay";
}

function countMatches(text: string, re: RegExp): number {
  let n = 0;
  for (const _ of text.matchAll(re)) n++;
  return n;
}

/**
 * Ids that name a SERVER, not a peer.
 *
 * `Capture.peers` holds every id any vantage mentioned, and that includes the
 * relay's own peerId and a log vantage's observer name. Neither belongs in a
 * peer graph, a peer matrix or a peer picker. The set is exact rather than a
 * guess: it comes from each vantage's kind and from each bundle's own config.
 */
function serversOf(c: Capture): Set<string> {
  const out = new Set<string>();
  for (const v of c.vantages) {
    if (v.kind !== "client" && v.observer !== "") out.add(v.observer);
    const configured = v.bundle?.config.relayPeerId;
    if (configured) out.add(configured);
    if (v.relay) out.add(v.relay.relayPeerId);
  }
  return out;
}

function countFindings(list: Finding[]): FindingCounts {
  const counts: FindingCounts = { block: 0, warn: 0, info: 0 };
  for (const f of list) counts[f.severity]++;
  return counts;
}

function laneKeyOfVantage(kind: VantageKind, observer: string, source: string): string {
  if (kind === "client") return `client:${observer}`;
  if (kind === "relay") return "relay";
  if (kind === "sfu") return "sfu";
  return `log:${source}`;
}

function laneLabel(kind: VantageKind, observer: string, source: string): string {
  if (kind === "client") return shortPeer(observer);
  if (kind === "relay") return "relay";
  if (kind === "sfu") return "sfu";
  return source;
}

export function laneKeyOf(e: MergedEvent): string {
  return laneKeyOfVantage(e.vantage, e.observer, e.source);
}

function errText(err: unknown): string {
  return err instanceof Error ? `${err.name}: ${err.message}` : String(err);
}

/** Accept an OpenAI-shaped reply, and fall back to the raw body. */
function extractReply(body: string): string {
  try {
    const j = JSON.parse(body) as {
      choices?: Array<{ message?: { content?: string } }>;
      content?: Array<{ text?: string }>;
    };
    const openai = j.choices?.[0]?.message?.content;
    if (typeof openai === "string") return openai;
    const anthropic = j.content?.map((p) => p.text ?? "").join("");
    if (anthropic) return anthropic;
  } catch {
    // Not JSON. The raw body is the most honest answer.
  }
  return body;
}

// ---------------------------------------------------------------------------
// Display helpers
//
// Presentation, not analysis. They live here because this is the console's one
// shared module, and nine views must format a peerId the same way.
// ---------------------------------------------------------------------------

/** The last 8 characters, which is what the relay's own logs print. */
export function shortPeer(peerId: string): string {
  if (peerId === "") return "-";
  return peerId.length <= 8 ? peerId : `…${peerId.slice(-8)}`;
}

export function fmtClock(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "--:--:--.---";
  const d = new Date(ms);
  const p = (n: number, w = 2): string => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

export function fmtDate(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "-";
  return new Date(ms).toISOString().replace("T", " ").replace("Z", "");
}

export function fmtDur(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "-";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${Math.round(s % 60)}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${(n / 1024 / 1024).toFixed(2)} MiB`;
}

/** A token reference, never a literal colour. See `app.css`. */
export function sevColor(sev: DiagSeverity): string {
  return `var(--color-sev-${sev})`;
}

export function severityColor(sev: Finding["severity"]): string {
  if (sev === "block") return "var(--color-sev-error)";
  if (sev === "warn") return "var(--color-sev-warn)";
  return "var(--color-sev-info)";
}

export function linkColor(state: LinkState): string {
  return `var(--color-ls-${state})`;
}

/** A flat `d` bag as one line. Keys stay in insertion order. */
export function fmtDetail(
  d: Record<string, string | number | boolean | null> | undefined
): string {
  if (!d) return "";
  return Object.entries(d)
    .map(([k, v]) => `${k}=${v === null ? "null" : maskValue(k, v)}`)
    .join(" ");
}

/**
 * An SFU or relay log line carries a room code in CLEAR, and `logs.ts` keeps it
 * as `d.roomRaw`. A room code is the room's only membership secret, so it must
 * not appear in a view an operator screenshots or pastes into a ticket.
 *
 * This is the single render boundary for a `d` bag, so it is the right place to
 * mask it. The Logs view's raw pane still shows the file verbatim, because that
 * is the file the operator asked to read.
 */
function maskValue(key: string, value: string | number | boolean): string {
  if (key === "roomRaw") return "«room code held back»";
  return String(value);
}
