<!--
  Timeline: every vantage's events in one absolute-time stream, in lanes.

  One lane per observer, plus a relay lane and an SFU lane. The lane strip is
  the whole capture at a glance; the table below is the same filtered rows in
  detail. The scrubber drives the Topology view, and the cursor drives the
  scrubber, so `j`/`k` walks the graph forward and back.

  Keys: j next event, k previous event, f next finding evidence.
-->
<script lang="ts">
  import type { DiagSeverity } from "$lib/schema";
  import {
    app,
    evidenceIndices,
    fmtClock,
    fmtDetail,
    fmtDur,
    goTo,
    nextEvidence,
    scrubTo,
    setCursor,
    setFilter,
    sevColor,
    shortPeer,
    stepCursor,
  } from "$lib/sources.svelte";

  /** Ordered for the strip's "worst severity in this bucket" fold. */
  const SEVS: readonly DiagSeverity[] = ["debug", "info", "warn", "error"];
  const RANK: Record<DiagSeverity, number> = { debug: 0, info: 1, warn: 2, error: 3 };

  /** Strip resolution. 320 columns fits any window on a laptop screen. */
  const BUCKETS = 320;
  /** The DOM stays honest at this size; a bigger table is unreadable anyway. */
  const MAX_ROWS = 3000;

  const capture = $derived(app.capture);
  const span = $derived(
    capture ? Math.max(1, capture.window.to - capture.window.from) : 1
  );
  const evidence = $derived(new Set(evidenceIndices()));

  const strip = $derived.by(() => {
    if (!capture) return [];
    const byLane = new Map<string, number[]>();
    for (const lane of app.lanes) byLane.set(lane.key, new Array<number>(BUCKETS).fill(-1));
    for (const r of app.rows) {
      const arr = byLane.get(r.lane);
      if (!arr) continue;
      const b = Math.min(
        BUCKETS - 1,
        Math.floor(((r.e.at - capture.window.from) / span) * BUCKETS)
      );
      const rank = RANK[r.e.sev];
      if (rank > arr[b]) arr[b] = rank;
    }
    return app.lanes.map((lane) => ({
      lane,
      cells: (byLane.get(lane.key) ?? []).flatMap((rank, i) =>
        rank < 0 ? [] : [{ i, sev: SEVS[rank] }]
      ),
    }));
  });

  const scrubPct = $derived(
    capture ? ((app.at - capture.window.from) / span) * 100 : 0
  );

  const visible = $derived(app.rows.slice(0, MAX_ROWS));

  let body = $state<HTMLTableSectionElement | null>(null);

  // Keep the cursor row on screen while `j`/`k` walks the stream.
  $effect(() => {
    const at = app.cursor;
    if (at === null || !body) return;
    body.children[at]?.scrollIntoView({ block: "nearest" });
  });

  function key(e: KeyboardEvent): void {
    const el = e.target as HTMLElement | null;
    const tag = el?.tagName ?? "";
    if (tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA") return;
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === "j") stepCursor(1);
    else if (e.key === "k") stepCursor(-1);
    else if (e.key === "f") nextEvidence();
    else return;
    e.preventDefault();
  }

  /** Click anywhere on a lane strip to scrub to that instant. */
  function scrubFromClick(e: MouseEvent): void {
    if (!capture) return;
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const frac = Math.min(Math.max((e.clientX - box.left) / box.width, 0), 1);
    scrubTo(capture.window.from + frac * span);
  }
</script>

<svelte:window onkeydown={key} />

{#if !capture}
  <p class="text-dim">
    No capture selected. Pick one in
    <button class="text-key underline" onclick={() => goTo("sessions")}>Sessions</button>.
  </p>
{:else}
  <div class="flex h-full flex-col gap-2">
    <!-- Filter -->
    <div class="flex flex-wrap items-center gap-2">
      <label class="flex items-center gap-1">
        <span class="font-mono text-[10px] tracking-wider text-faint uppercase">sev</span>
        <select
          class="field"
          value={app.filter.minSev}
          onchange={(e) =>
            setFilter({
              minSev: (e.currentTarget as HTMLSelectElement).value as DiagSeverity,
            })}
        >
          {#each SEVS as s (s)}
            <option value={s}>{s}+</option>
          {/each}
        </select>
      </label>

      <input
        class="field w-40"
        placeholder="kind prefix, e.g. voice."
        value={app.filter.kindPrefix}
        oninput={(e) => setFilter({ kindPrefix: (e.currentTarget as HTMLInputElement).value })}
      />

      <select
        class="field"
        value={app.filter.peer}
        onchange={(e) => setFilter({ peer: (e.currentTarget as HTMLSelectElement).value })}
      >
        <option value="">every peer</option>
        {#each app.peers as p (p.peerId)}
          <option value={p.peerId}>{shortPeer(p.peerId)}</option>
        {/each}
      </select>

      <button
        class="btn"
        onclick={() =>
          setFilter({ from: Math.round(app.at - 15_000), to: Math.round(app.at + 15_000) })}
        >±15s of cursor</button
      >
      {#if app.filter.from !== null || app.filter.to !== null}
        <button class="btn btn-on" onclick={() => setFilter({ from: null, to: null })}>
          clear time range
        </button>
      {/if}

      <span class="ml-auto font-mono text-[11px] text-faint">
        {app.rows.length} of {capture.timeline.length} events
        · <kbd class="text-dim">j/k</kbd> step · <kbd class="text-dim">f</kbd> next evidence
      </span>
    </div>

    <!-- Lanes -->
    <section class="panel shrink-0">
      <h2 class="panel-head">
        lanes
        <span class="text-faint">{fmtClock(capture.window.from)} → {fmtClock(capture.window.to)}</span>
        <span class="ml-auto" style="color: var(--color-key)">
          cursor {fmtClock(app.at)} (+{fmtDur(app.at - capture.window.from)})
        </span>
      </h2>

      <div class="relative">
        {#each strip as row (row.lane.key)}
          <div class="grid grid-cols-[7.5rem_1fr] items-center gap-2 px-2 py-px">
            <span class="truncate font-mono text-[10px]" title={row.lane.key}>
              <span
                style="color: {row.lane.kind === 'client'
                  ? 'var(--color-text)'
                  : 'var(--color-dim)'}">{row.lane.label}</span
              >
              <span class="text-faint">{row.lane.kind}</span>
            </span>
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <!-- svelte-ignore a11y_click_events_have_key_events -->
            <div class="h-3.5 bg-ink" onclick={scrubFromClick}>
              <svg
                viewBox="0 0 {BUCKETS} 10"
                preserveAspectRatio="none"
                class="h-full w-full"
                aria-label="{row.lane.label} events over time"
              >
                {#each row.cells as cell (cell.i)}
                  <rect
                    x={cell.i}
                    y={cell.sev === "error" ? 0 : cell.sev === "warn" ? 1.5 : 3}
                    width="1"
                    height={cell.sev === "error" ? 10 : cell.sev === "warn" ? 7 : 4}
                    fill={sevColor(cell.sev)}
                  />
                {/each}
              </svg>
            </div>
          </div>
        {/each}

        <!-- Keyframes: where the topology actually changed. -->
        <div class="grid grid-cols-[7.5rem_1fr] items-center gap-2 px-2 pt-1 pb-0.5">
          <span class="font-mono text-[10px] text-faint">keyframes</span>
          <div class="relative h-2">
            {#each app.keyframes as k (k)}
              <span
                class="absolute top-0 h-2 w-px bg-line"
                style="left: {((k - capture.window.from) / span) * 100}%"
              ></span>
            {/each}
          </div>
        </div>

        <!-- The scrubber. It sits over the whole strip so its instant is unambiguous. -->
        <span
          class="pointer-events-none absolute inset-y-0 w-px"
          style="left: calc(7.5rem + 0.5rem + (100% - 8rem - 0.5rem) * {scrubPct / 100}); background-color: var(--color-key)"
        ></span>
      </div>

      <div class="border-t border-line/50 px-2 py-1">
        <input
          type="range"
          class="w-full accent-key"
          aria-label="scrub time"
          min={capture.window.from}
          max={capture.window.to}
          step="1"
          value={app.at}
          oninput={(e) => scrubTo(Number((e.currentTarget as HTMLInputElement).value))}
        />
      </div>
    </section>

    <!-- Events -->
    <section class="panel min-h-0 flex-1 overflow-auto">
      <table class="tbl">
        <thead>
          <tr>
            <th>time</th>
            <th>+</th>
            <th>lane</th>
            <th>sev</th>
            <th>kind</th>
            <th>peer</th>
            <th>room</th>
            <th>detail</th>
          </tr>
        </thead>
        <tbody bind:this={body}>
          {#each visible as row, n (row.i)}
            <tr
              class="cursor-pointer {app.cursor === n ? 'bg-raise' : ''}"
              onclick={() => setCursor(n)}
            >
              <td class="whitespace-nowrap" style="color: {app.cursor === n ? 'var(--color-key)' : ''}">
                {#if evidence.has(row.i)}<span style="color: var(--color-sev-error)">●</span>{:else}<span
                    class="text-faint">·</span
                  >{/if}
                {fmtClock(row.e.at)}
              </td>
              <td class="text-right text-faint">{row.e.t === row.e.at ? "" : row.e.t}</td>
              <td class="text-dim">{shortPeer(row.e.observer)}</td>
              <td style="color: {sevColor(row.e.sev)}">{row.e.sev}</td>
              <td>{row.e.kind}</td>
              <td class="text-dim" title={row.e.peer ?? ""}>
                {row.e.peer ? shortPeer(row.e.peer) : ""}
              </td>
              <td class="text-faint">{row.e.room ?? ""}</td>
              <td class="max-w-[36rem] break-words text-dim">{fmtDetail(row.e.d)}</td>
            </tr>
          {/each}
        </tbody>
      </table>

      {#if app.rows.length > MAX_ROWS}
        <p class="p-2 text-[11px]" style="color: var(--color-sev-warn)">
          The table shows the first {MAX_ROWS} of {app.rows.length} rows. Narrow
          the filter or set a time range to see the rest.
        </p>
      {/if}
    </section>
  </div>
{/if}
