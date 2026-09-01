<script lang="ts">
  import { Label } from "$lib/components/ui/label";
  import { Button } from "$lib/components/ui/button";
  import { Switch } from "$lib/components/ui/switch";
  import {
    Activity,
    Check,
    Copy,
    Download,
    Trash2,
    Upload as UploadIcon,
  } from "@lucide/svelte";
  import {
    recorderSnapshot,
    type RecorderSnapshot,
  } from "$lib/telemetry/recorder";
  import {
    diagPrefs,
    setDiagPersist,
    setDiagUpload,
  } from "$lib/telemetry/prefs.svelte";
  import { buildClientBundle } from "$lib/telemetry/bundle";
  import {
    DIAG_KEEP_SESSIONS,
    DIAG_MAX_BYTES,
    clearStoredDiagnostics,
    startDiagPersistence,
    stopDiagPersistence,
    storedDiagSessions,
  } from "$lib/telemetry/store";
  import { collectorAvailable, uploadBundle } from "$lib/telemetry/upload";
  import type { DiagSessionSummary } from "$lib/storage";
  import type { DiagSeverity } from "$lib/telemetry/schema";

  interface Props {
    activeTab?: string;
  }

  let { activeTab = "diagnostics" }: Props = $props();

  /** The newest 50 events reach the table. Older events stay in the bundle. */
  const RECENT_LIMIT = 50;
  /** How many suppressed kinds the summary names. */
  const TOP_SUPPRESSED = 3;
  /** Refresh cadence for the in-memory numbers while the pane is open. */
  const REFRESH_MS = 1000;
  /** Refresh cadence for the disk list. A cursor walk is not a per-second job. */
  const STORED_REFRESH_MS = 5000;

  /**
   * One rendered row. Flat strings on purpose: the table stays dumb, and the
   * detail bag is formatted once per refresh instead of once per render.
   */
  interface EventRow {
    seq: number;
    t: number;
    kind: string;
    sev: DiagSeverity;
    peerTail: string;
    detail: string;
  }

  /** A display-only projection. It holds no event object and no nested bag. */
  interface RecorderView {
    sessionId: string;
    held: number;
    dropped: number;
    ringCapacity: number;
    faultsActive: boolean;
    topSuppressed: Array<{ kind: string; count: number }>;
    recent: EventRow[];
  }

  // A `RecorderSnapshot` NEVER enters a rune: a `$state` proxy cannot be
  // structured-cloned, and `JSON.stringify` of a proxy is the bug
  // `DataSettings.svelte:124-127` records. So the render path holds this flat
  // projection, and the export path passes a fresh plain snapshot straight to
  // `buildClientBundle`.
  let view = $state<RecorderView | null>(null);

  let stored = $state<DiagSessionSummary[]>([]);
  let collectorOk = $state(false);
  let copied = $state(false);
  let busy = $state(false);
  let actionNote = $state<string | null>(null);
  let actionFailed = $state(false);
  let confirmClear = $state(false);

  function project(s: RecorderSnapshot): RecorderView {
    const recent = s.events.slice(-RECENT_LIMIT).map((e) => ({
      seq: e.seq,
      t: e.t,
      kind: e.kind as string,
      sev: e.sev,
      peerTail: e.peer ? e.peer.slice(-8) : "",
      detail: e.d
        ? Object.entries(e.d)
            .map(([k, v]) => `${k}=${String(v)}`)
            .join(" ")
        : "",
    }));
    const topSuppressed = Object.entries(s.suppressed)
      .map(([kind, count]) => ({ kind, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, TOP_SUPPRESSED);
    return {
      sessionId: s.sessionId,
      held: s.events.length,
      dropped: s.dropped,
      ringCapacity: s.ringCapacity,
      faultsActive: s.faultsActive,
      topSuppressed,
      recent,
    };
  }

  function refreshView(): void {
    view = project(recorderSnapshot());
  }

  async function refreshStored(): Promise<void> {
    stored = await storedDiagSessions();
  }

  // A 204 from the ingest route means the operator never set the collector up.
  // The probe runs only while the pane is open, and the module memoizes it.
  async function probeCollector(): Promise<void> {
    collectorOk = await collectorAvailable();
  }

  $effect(() => {
    if (activeTab !== "diagnostics") return;
    refreshView();
    void refreshStored();
    void probeCollector();
    const live = setInterval(refreshView, REFRESH_MS);
    // The disk list is live too, so a user who just turned persist on sees the
    // first chunk arrive instead of a stale "None on disk".
    const disk = setInterval(() => void refreshStored(), STORED_REFRESH_MS);
    return () => {
      clearInterval(live);
      clearInterval(disk);
    };
  });

  // This pane is the ONLY place that starts persistence, so a user who never
  // opens Settings pays nothing: no timer, no IndexedDB write, no sealed row.
  // The timer outlives the pane on purpose - a closed dialog must not stop a
  // capture that the user asked for.
  $effect(() => {
    if (diagPrefs.persist) startDiagPersistence();
    else stopDiagPersistence();
  });

  function randomHex(bytes: number): string {
    const b = new Uint8Array(bytes);
    crypto.getRandomValues(b);
    return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
  }

  /**
   * The bundle is built from a FRESH plain snapshot, so an export holds every
   * event up to the click rather than the last table refresh.
   */
  function currentBundle() {
    const fresh = recorderSnapshot();
    view = project(fresh);
    return buildClientBundle(fresh, {
      version: __APP_VERSION__,
      commit: __APP_COMMIT__,
      ua: navigator.userAgent,
      now: Date.now(),
      randomHex,
    });
  }

  function note(text: string, failed: boolean): void {
    actionNote = text;
    actionFailed = failed;
  }

  async function copySessionId(): Promise<void> {
    if (!view?.sessionId) return;
    try {
      await navigator.clipboard.writeText(view.sessionId);
      copied = true;
      setTimeout(() => (copied = false), 1200);
    } catch {
      // Clipboard blocked: the id is visible to select by hand.
    }
  }

  function handleExport(): void {
    const bundle = currentBundle();
    const blob = new Blob([JSON.stringify(bundle, null, 2)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    try {
      const a = document.createElement("a");
      a.href = url;
      a.download = `awful-diag-${bundle.bundleId}.json`;
      a.click();
      note(`The app wrote awful-diag-${bundle.bundleId}.json.`, false);
    } finally {
      // Revoked in a `finally`: a leaked object URL holds the whole bundle in
      // memory for the life of the document.
      URL.revokeObjectURL(url);
    }
  }

  /** Plain words for every refusal. A reason code alone helps nobody. */
  function uploadReasonText(reason: string): string {
    switch (reason) {
      case "disabled":
        return "The operator did not set a collector up on this instance.";
      case "off":
        return "The upload switch is off. Turn it on first.";
      case "too-large":
        return "The bundle is too large, even after a trim.";
      case "unauthorized":
        return "The relay refused the signature on this upload.";
      case "rate-limited":
        return "The relay took too many uploads. Wait a minute.";
      case "network":
        return "The relay did not answer. Check your connection.";
      default:
        return `The upload failed: ${reason}.`;
    }
  }

  async function handleUpload(): Promise<void> {
    busy = true;
    try {
      const result = await uploadBundle(currentBundle());
      if (result.ok)
        note(`The relay took the bundle. Id ${result.bundleId}.`, false);
      else note(uploadReasonText(result.reason), true);
    } finally {
      busy = false;
    }
  }

  async function handleClear(): Promise<void> {
    busy = true;
    confirmClear = false;
    try {
      await clearStoredDiagnostics();
      await refreshStored();
      note("The app deleted every stored chunk.", false);
    } finally {
      busy = false;
    }
  }

  function formatBytes(bytes: number): string {
    if (bytes <= 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.min(
      Math.floor(Math.log(bytes) / Math.log(k)),
      sizes.length - 1
    );
    return `${parseFloat((bytes / Math.pow(k, i)).toFixed(2))} ${sizes[i]}`;
  }

  function formatStart(ms: number): string {
    return ms > 0 ? new Date(ms).toLocaleString() : "unknown";
  }

  const SEV_CLASS: Record<DiagSeverity, string> = {
    debug: "text-muted-foreground/70",
    info: "text-muted-foreground",
    warn: "text-amber-500",
    error: "text-destructive",
  };
</script>

<div class="flex flex-col gap-6">
  <!-- Recorder Section -->
  <div
    class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
  >
    <div class="flex items-center gap-2">
      <div class="w-1 h-4 bg-sky-500 rounded-full"></div>
      <Label
        class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
        >Recorder</Label
      >
    </div>
    <p class="text-xs font-mono text-muted-foreground leading-relaxed">
      The recorder is always on, in memory, from the first connection. Nothing
      leaves this tab until you export a bundle, or you turn the upload switch
      on.
    </p>

    {#if view}
      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between gap-3">
          <span class="text-xs font-mono text-muted-foreground">Session</span>
          <div class="flex items-center gap-1 min-w-0">
            <span class="text-xs font-mono truncate">
              {view.sessionId || "no session yet"}
            </span>
            {#if view.sessionId}
              <Button
                variant="ghost"
                size="sm"
                class="h-6 px-1.5 font-mono text-xs text-muted-foreground"
                onclick={copySessionId}
                aria-label="Copy session id"
              >
                {#if copied}
                  <Check class="w-3 h-3" />
                {:else}
                  <Copy class="w-3 h-3" />
                {/if}
              </Button>
            {/if}
          </div>
        </div>
        <div class="flex items-center justify-between gap-3">
          <span class="text-xs font-mono text-muted-foreground">Events held</span
          >
          <span class="text-xs font-mono"
            >{view.held} / {view.ringCapacity}</span
          >
        </div>
        <div class="flex items-center justify-between gap-3">
          <span class="text-xs font-mono text-muted-foreground">Dropped</span>
          <span class="text-xs font-mono">{view.dropped}</span>
        </div>
        <div class="flex items-center justify-between gap-3">
          <span class="text-xs font-mono text-muted-foreground">Suppressed</span>
          <span class="text-xs font-mono text-right truncate">
            {#if view.topSuppressed.length === 0}
              none
            {:else}
              {view.topSuppressed
                .map((s) => `${s.kind} ${s.count}`)
                .join(", ")}
            {/if}
          </span>
        </div>
        <div class="flex items-center justify-between gap-3">
          <span class="text-xs font-mono text-muted-foreground"
            >Fault injection</span
          >
          <span
            class="text-xs font-mono {view.faultsActive
              ? 'text-amber-500'
              : ''}">{view.faultsActive ? "active" : "off"}</span
          >
        </div>
      </div>
    {/if}
  </div>

  <!-- Exits Section -->
  <div
    class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
  >
    <div class="flex items-center gap-2">
      <div class="w-1 h-4 bg-sky-500 rounded-full"></div>
      <Label
        class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
        >Exits</Label
      >
    </div>
    <div class="flex items-center justify-between gap-3">
      <div class="flex flex-col gap-1 min-w-0">
        <span class="text-xs font-mono">Keep diagnostics across reloads</span>
        <span class="text-xs font-mono text-muted-foreground leading-relaxed">
          The app writes sealed event chunks to this device, so a crash or a
          reload keeps the history. Off holds the events in memory only.
        </span>
      </div>
      <Switch
        checked={diagPrefs.persist}
        onCheckedChange={(checked) => setDiagPersist(checked)}
      />
    </div>
    <div class="flex items-center justify-between gap-3">
      <div class="flex flex-col gap-1 min-w-0">
        <span class="text-xs font-mono">Allow upload to this instance</span>
        <span class="text-xs font-mono text-muted-foreground leading-relaxed">
          An upload hands the relay your connection diagnostics: dial outcomes,
          ICE candidate TYPES, transport states, timings, counters and error
          codes. It never sends message content, never a did:key, never a room
          code, and never an ICE candidate address.
        </span>
      </div>
      <Switch
        checked={diagPrefs.upload}
        onCheckedChange={(checked) => setDiagUpload(checked)}
      />
    </div>
  </div>

  <!-- Actions Section -->
  <div
    class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
  >
    <div class="flex items-center gap-2">
      <div class="w-1 h-4 bg-sky-500 rounded-full"></div>
      <Label
        class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
        >Actions</Label
      >
    </div>
    <div class="flex flex-col gap-2 sm:flex-row">
      <Button
        variant="outline"
        class="flex-1 font-mono text-xs"
        disabled={busy || !view?.sessionId}
        onclick={handleExport}
      >
        <Download class="w-3.5 h-3.5 mr-2" />
        Export bundle
      </Button>
      <!-- Hidden, not disabled, when the collector answers 204: the operator
           never set one up, so a button here would promise a route that is
           not there. -->
      {#if collectorOk}
        <Button
          variant="outline"
          class="flex-1 font-mono text-xs"
          disabled={busy || !view?.sessionId}
          onclick={handleUpload}
        >
          <UploadIcon class="w-3.5 h-3.5 mr-2" />
          Upload bundle
        </Button>
      {/if}
    </div>

    {#if actionNote}
      <p
        class="text-xs font-mono leading-relaxed {actionFailed
          ? 'text-destructive'
          : 'text-muted-foreground'}"
      >
        {actionNote}
      </p>
    {/if}

    <div class="flex flex-col gap-2 bg-muted/50 rounded-lg p-3">
      <span class="text-xs font-mono text-muted-foreground">
        Stored sessions
      </span>
      {#if stored.length === 0}
        <span class="text-xs font-mono text-muted-foreground/70">
          None on disk. The persist switch above is what writes them.
        </span>
      {:else}
        {#each stored as s (s.sessionId)}
          <div class="flex items-center justify-between gap-3">
            <span class="text-xs font-mono truncate"
              >{s.sessionId.slice(0, 12)}… · {formatStart(s.startedAt)}</span
            >
            <span class="text-xs font-mono text-muted-foreground shrink-0"
              >{s.chunks} chunks · {formatBytes(s.bytes)}</span
            >
          </div>
        {/each}
      {/if}
      <span class="text-xs font-mono text-muted-foreground/70 leading-relaxed">
        This device keeps {DIAG_KEEP_SESSIONS} sessions and {formatBytes(
          DIAG_MAX_BYTES
        )} of diagnostics. Past either limit, the app deletes the oldest session
        first.
      </span>
    </div>

    {#if !confirmClear}
      <Button
        variant="ghost"
        class="w-full font-mono text-xs text-muted-foreground
          hover:bg-destructive/10! hover:text-destructive!"
        disabled={busy || stored.length === 0}
        onclick={() => (confirmClear = true)}
      >
        <Trash2 class="w-3.5 h-3.5 mr-2" />
        Clear stored diagnostics
      </Button>
    {:else}
      <div class="flex gap-2">
        <Button
          variant="outline"
          class="flex-1 font-mono text-xs"
          onclick={() => (confirmClear = false)}
        >
          Cancel
        </Button>
        <Button
          variant="destructive"
          class="flex-1 font-mono text-xs"
          disabled={busy}
          onclick={handleClear}
        >
          Delete every chunk
        </Button>
      </div>
    {/if}
  </div>

  <!-- Recent Events Section -->
  <div
    class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
  >
    <div class="flex items-center gap-2">
      <div class="w-1 h-4 bg-sky-500 rounded-full"></div>
      <Label
        class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
        >Recent Events</Label
      >
    </div>
    {#if !view || view.recent.length === 0}
      <div class="flex items-center gap-2 py-4">
        <Activity class="w-4 h-4 text-muted-foreground" />
        <span class="text-xs font-mono text-muted-foreground">
          No events yet. The recorder starts with the first connection.
        </span>
      </div>
    {:else}
      <div class="overflow-x-auto">
        <table class="w-full font-mono text-[11px] border-collapse">
          <thead>
            <tr class="text-muted-foreground/70 text-left">
              <th class="pr-3 pb-1 font-normal">ms</th>
              <th class="pr-3 pb-1 font-normal">kind</th>
              <th class="pr-3 pb-1 font-normal">peer</th>
              <th class="pb-1 font-normal">detail</th>
            </tr>
          </thead>
          <tbody>
            {#each view.recent as e (e.seq)}
              <tr class={SEV_CLASS[e.sev]}>
                <td class="pr-3 align-top tabular-nums whitespace-nowrap"
                  >{e.t}</td
                >
                <td class="pr-3 align-top whitespace-nowrap">{e.kind}</td>
                <td class="pr-3 align-top whitespace-nowrap">{e.peerTail}</td>
                <td class="align-top break-all">{e.detail}</td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
      <p class="text-xs font-mono text-muted-foreground/70 leading-relaxed">
        The newest {RECENT_LIMIT} events, with the time in milliseconds after the
        session start. A gap in the times means the ring or the throttle dropped
        events.
      </p>
    {/if}
  </div>
</div>
