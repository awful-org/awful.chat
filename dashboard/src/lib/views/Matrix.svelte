<!--
  Matrix: the N×N pairwise link grid at the scrubbed instant.

  Every cell is ONE square split on its anti-diagonal:

    upper-left triangle   what the ROW peer believed about the COLUMN peer
    lower-right triangle  what the COLUMN peer believed about the ROW peer

  When the two agree the square is one flat colour and the split is invisible.
  When they disagree the square reads as two colours with a hard white seam.
  "Works for A but not B" is therefore a shape, not a number to compare.

  A half whose observer uploaded no vantage is not a disagreement, it is
  ignorance. Those halves are drawn faint with a "?" so they never read as red.
-->
<script lang="ts">
  import type { LinkState } from "$lib/analysis/topology";
  import {
    app,
    fmtClock,
    goTo,
    linkAt,
    linkColor,
    observersWithVantage,
    scrubTo,
    selectPeer,
    setFilter,
    shortPeer,
  } from "$lib/sources.svelte";

  const CELL = 30;

  const peers = $derived(app.peers);
  const witnesses = $derived(new Set(observersWithVantage()));

  interface Half {
    state: LinkState;
    known: boolean;
  }

  function half(from: string, to: string): Half {
    if (!witnesses.has(from)) return { state: "none", known: false };
    return { state: linkAt(from, to)?.state ?? "none", known: true };
  }

  function color(h: Half): string {
    return h.known ? linkColor(h.state) : "var(--color-ink)";
  }

  /** Pairs where two witnesses actually disagree. This is the view's headline. */
  const splits = $derived.by(() => {
    const out: Array<{ a: string; b: string; ab: LinkState; ba: LinkState }> = [];
    for (let i = 0; i < peers.length; i++) {
      for (let j = i + 1; j < peers.length; j++) {
        const a = peers[i].peerId;
        const b = peers[j].peerId;
        const ab = half(a, b);
        const ba = half(b, a);
        if (!ab.known || !ba.known) continue;
        if (ab.state !== ba.state) out.push({ a, b, ab: ab.state, ba: ba.state });
      }
    }
    return out;
  });
</script>

{#if !app.capture}
  <p class="text-dim">
    No capture selected. Pick one in
    <button class="text-key underline" onclick={() => goTo("sessions")}>Sessions</button>.
  </p>
{:else if peers.length === 0}
  <p class="text-dim">This capture names no peer.</p>
{:else}
  <div class="flex flex-col gap-2">
    <div class="flex flex-wrap items-center gap-2">
      <span class="font-mono text-[11px]" style="color: var(--color-key)">{fmtClock(app.at)}</span>
      <input
        type="range"
        class="min-w-48 flex-1 accent-key"
        aria-label="scrub time"
        min={app.capture.window.from}
        max={app.capture.window.to}
        step="1"
        value={app.at}
        oninput={(e) => scrubTo(Number((e.currentTarget as HTMLInputElement).value))}
      />
      <span
        class="chip"
        style="color: {splits.length > 0 ? 'var(--color-sev-error)' : 'var(--color-ls-proven)'}"
      >
        {splits.length} asymmetric pair{splits.length === 1 ? "" : "s"}
      </span>
      <span class="font-mono text-[10px] text-faint">
        {witnesses.size} of {peers.length} peers uploaded a vantage
      </span>
    </div>

    <div class="panel p-2">
      <div class="mb-2 pb-2 border-b border-line flex flex-wrap items-center gap-x-4 gap-y-1">
        <span class="font-mono text-[10px] text-faint">link states:</span>
        {#each ["none", "dialing", "dial-failed", "relayed", "direct", "proven", "lost", "dropped"] as LinkState[] as s (s)}
          <span class="flex items-center gap-1 font-mono text-[10px] text-dim">
            <span class="inline-block h-2.5 w-2.5" style="background-color: {linkColor(s)}"></span>
            {s}
          </span>
        {/each}
      </div>
      <p class="text-[10px] text-faint mb-2">
        Upper-left = row→column. Lower-right = column→row. Flat = agree. Seam = disagree. ? = no vantage.
      </p>
    </div>

    <div class="panel overflow-auto p-2">
      <table style="border-collapse: separate; border-spacing: 2px">
        <thead>
          <tr>
            <th></th>
            {#each peers as p, j (p.peerId)}
              <th
                class="font-mono text-[10px] font-normal hover:text-key transition-colors p-0.5"
                style="width: {CELL}px; color: {witnesses.has(p.peerId)
                  ? 'var(--color-dim)'
                  : 'var(--color-faint)'}; cursor: default"
                title="{p.peerId}{witnesses.has(p.peerId) ? '' : ' (no vantage)'}">{j + 1}</th
              >
            {/each}
          </tr>
        </thead>
        <tbody>
          {#each peers as row, i (row.peerId)}
            <tr>
              <th class="pr-2 text-right font-mono text-[10px] font-normal whitespace-nowrap">
                <button
                  class="hover:text-key hover:underline transition-colors p-0.5"
                  style="color: {witnesses.has(row.peerId)
                    ? 'var(--color-text)'
                    : 'var(--color-faint)'}; cursor: pointer"
                  title="{row.peerId}{witnesses.has(row.peerId)
                    ? ''
                    : ' — no vantage, so this row is unknown, not broken'}"
                  onclick={() => {
                    selectPeer(row.peerId);
                    goTo("peers");
                  }}
                >
                  {i + 1}. {shortPeer(row.peerId)}
                </button>
              </th>

              {#each peers as col, j (col.peerId)}
                {#if i === j}
                  <td
                    style="width: {CELL}px; height: {CELL}px; background-color: var(--color-raise)"
                  ></td>
                {:else}
                  {@const ab = half(row.peerId, col.peerId)}
                  {@const ba = half(col.peerId, row.peerId)}
                  {@const differs = ab.known && ba.known && ab.state !== ba.state}
                  <td style="width: {CELL}px; height: {CELL}px; padding: 0">
                    <button
                      class="block w-full h-full hover:outline hover:outline-2 hover:outline-key transition-all"
                      style="width: {CELL}px; height: {CELL}px; cursor: pointer"
                      title="{shortPeer(row.peerId)} → {shortPeer(col.peerId)}: {ab.known
                        ? ab.state
                        : 'no vantage'} | {shortPeer(col.peerId)} → {shortPeer(
                        row.peerId
                      )}: {ba.known ? ba.state : 'no vantage'}"
                      onclick={() => {
                        setFilter({ peer: col.peerId });
                        goTo("timeline");
                      }}
                    >
                      <svg viewBox="0 0 30 30" class="block h-full w-full" aria-hidden="true">
                        <polygon points="0,0 30,0 0,30" fill={color(ab)} />
                        <polygon points="30,0 30,30 0,30" fill={color(ba)} />
                        {#if differs}
                          <line
                            x1="30"
                            y1="0"
                            x2="0"
                            y2="30"
                            stroke="var(--color-text)"
                            stroke-width="2"
                          />
                        {/if}
                        {#if !ab.known}
                          <text
                            x="9"
                            y="13"
                            text-anchor="middle"
                            class="text-[10px]"
                            fill="var(--color-faint)"
                            font-weight="bold">?</text
                          >
                        {/if}
                        {#if !ba.known}
                          <text
                            x="21"
                            y="26"
                            text-anchor="middle"
                            class="text-[10px]"
                            fill="var(--color-faint)"
                            font-weight="bold">?</text
                          >
                        {/if}
                      </svg>
                    </button>
                  </td>
                {/if}
              {/each}
            </tr>
          {/each}
        </tbody>
      </table>

    </div>

    {#if splits.length > 0}
      <section class="panel">
        <h2 class="panel-head" style="color: var(--color-sev-error)">asymmetric pairs</h2>
        <table class="tbl">
          <thead>
            <tr><th>a</th><th>a saw</th><th>b</th><th>b saw</th><th></th></tr>
          </thead>
          <tbody>
            {#each splits as s (`${s.a}|${s.b}`)}
              <tr>
                <td title={s.a}>{shortPeer(s.a)}</td>
                <td style="color: {linkColor(s.ab)}">{s.ab}</td>
                <td title={s.b}>{shortPeer(s.b)}</td>
                <td style="color: {linkColor(s.ba)}">{s.ba}</td>
                <td>
                  <button
                    class="btn"
                    onclick={() => {
                      selectPeer(s.b);
                      goTo("peers");
                    }}>Inspect {shortPeer(s.b)}</button
                  >
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </section>
    {/if}
  </div>
{/if}
