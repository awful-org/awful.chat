<!--
  The shell: a tab bar over nine views, and a header that always names the
  selected capture and its finding counts. The header is the answer to "what am
  I looking at", which a nine-tab console must never make the operator hunt for.
-->
<script lang="ts">
  import type { Component } from "svelte";
  import {
    TABS,
    app,
    fmtDate,
    fmtDur,
    goTo,
    type Tab,
  } from "$lib/sources.svelte";
  import Sources from "$lib/views/Sources.svelte";
  import Sessions from "$lib/views/Sessions.svelte";
  import Findings from "$lib/views/Findings.svelte";
  import Timeline from "$lib/views/Timeline.svelte";
  import Topology from "$lib/views/Topology.svelte";
  import Matrix from "$lib/views/Matrix.svelte";
  import PeerDetail from "$lib/views/PeerDetail.svelte";
  import Logs from "$lib/views/Logs.svelte";
  import Ai from "$lib/views/Ai.svelte";

  const VIEWS: Record<Tab, Component> = {
    sources: Sources,
    sessions: Sessions,
    findings: Findings,
    timeline: Timeline,
    topology: Topology,
    matrix: Matrix,
    peers: PeerDetail,
    logs: Logs,
    ai: Ai,
  };

  const Current = $derived(VIEWS[app.tab]);
  const capture = $derived(app.capture);
  const counts = $derived(app.findingCounts);
</script>

<div class="flex h-screen flex-col overflow-hidden">
  <header
    class="flex shrink-0 flex-wrap items-center gap-x-4 gap-y-1 border-b border-line bg-surface px-3 py-1.5"
  >
    <span class="font-mono text-[11px] tracking-widest text-faint uppercase">
      awful.chat diag
    </span>

    {#if capture}
      <span class="font-mono text-[11px] text-dim">
        {fmtDate(capture.window.from)}
        <span class="text-faint">+{fmtDur(capture.window.to - capture.window.from)}</span>
      </span>
      <span class="font-mono text-[11px] text-faint">
        {capture.vantages.length} vantage{capture.vantages.length === 1 ? "" : "s"}
        · {app.peers.length} peers · {capture.timeline.length} events
      </span>

      <span class="flex items-center gap-1.5">
        <span class="chip" style="color: var(--color-sev-error)">{counts.block} block</span>
        <span class="chip" style="color: var(--color-sev-warn)">{counts.warn} warn</span>
        <span class="chip" style="color: var(--color-sev-info)">{counts.info} info</span>
      </span>

      {#if app.skewSuspect}
        <span class="chip" style="color: var(--color-sev-warn)">
          clock skew {Math.round(capture.maxSkewResidualMs)}ms
        </span>
      {/if}
    {:else}
      <span class="text-dim">
        No capture. Load a bundle or a container log in <b class="text-key">Sources</b>.
      </span>
    {/if}
  </header>

  <div
    class="flex shrink-0 gap-px border-b border-line bg-ink px-2"
    role="tablist"
    aria-label="views"
  >
    {#each TABS as t (t.id)}
      <button
        type="button"
        role="tab"
        id="tab-{t.id}"
        aria-selected={app.tab === t.id}
        aria-controls="view"
        class="border-b-2 px-3 py-1.5 font-mono text-[11px] tracking-wide
               {app.tab === t.id
          ? 'border-key text-key'
          : 'border-transparent text-dim hover:text-text'}"
        onclick={() => goTo(t.id)}
      >
        {t.label}
      </button>
    {/each}
  </div>

  <main class="min-h-0 flex-1 overflow-auto">
    <div
      id="view"
      role="tabpanel"
      aria-labelledby="tab-{app.tab}"
      tabindex="-1"
      class="h-full p-3"
    >
      <Current />
    </div>
  </main>
</div>
