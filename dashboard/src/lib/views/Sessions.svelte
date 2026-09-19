<!--
  Sessions: the captures a workspace holds, newest first.

  A capture is a set of vantages whose windows overlap and that share a peerId.
  Selecting one drives every other view, so this is the second stop after
  Sources and the place to check that the grouping is what the operator expects.
-->
<script lang="ts">
  import {
    app,
    fmtDate,
    fmtDur,
    goTo,
    selectCapture,
    shortPeer,
  } from "$lib/sources.svelte";
</script>

{#if app.captureRows.length === 0}
  <div class="flex items-center justify-center h-full">
    <div class="text-center max-w-sm">
      <p class="text-dim mb-3">No capture loaded.</p>
      <p class="text-[11px] text-faint mb-4">
        Load a client bundle or container log to create a capture. Start in
      </p>
      <button class="btn" onclick={() => goTo("sources")}>Go to Sources</button>
    </div>
  </div>
{:else}
  <div class="flex flex-col gap-3">
    <table class="tbl">
      <thead>
        <tr>
          <th style="width: 1.5rem"></th>
          <th>window</th>
          <th class="text-right">span</th>
          <th>vantages</th>
          <th class="text-right">peers</th>
          <th class="text-right">events</th>
          <th class="text-right">skew</th>
          <th>findings</th>
        </tr>
      </thead>
      <tbody>
        {#each app.captureRows as row (row.capture.id)}
          {@const sel = app.capture?.id === row.capture.id}
          <tr
            role="button"
            tabindex="0"
            class="cursor-pointer transition-colors {sel
              ? 'bg-key/10 border-l-2 border-key'
              : 'hover:bg-raise border-l-2 border-transparent'}"
            onclick={() => selectCapture(row.capture.id)}
            onkeydown={(e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                selectCapture(row.capture.id);
              }
            }}
          >
            <td style="color: var(--color-key); padding-left: 0.25rem">{sel ? "▸" : ""}</td>
            <td>{fmtDate(row.capture.window.from)}</td>
            <td class="text-right text-dim">
              {fmtDur(row.capture.window.to - row.capture.window.from)}
            </td>
            <td>
              {#each row.kinds as k (k)}
                <span class="chip mr-1 text-dim">{k}</span>
              {/each}
              <span class="text-faint">({row.capture.vantages.length})</span>
            </td>
            <td class="text-right">{row.peerCount}</td>
            <td class="text-right">{row.capture.timeline.length}</td>
            <td
              class="text-right"
              style="color: {row.capture.maxSkewResidualMs > 2000
                ? 'var(--color-sev-warn)'
                : 'var(--color-faint)'}"
            >
              {Math.round(row.capture.maxSkewResidualMs)}ms
            </td>
            <td class="flex items-center gap-1">
              {#if row.counts.block > 0}
                <span class="chip" style="color: var(--color-sev-error)">{row.counts.block}</span>
              {/if}
              {#if row.counts.warn > 0}
                <span class="chip" style="color: var(--color-sev-warn)">{row.counts.warn}</span>
              {/if}
              {#if row.counts.info > 0}
                <span class="chip" style="color: var(--color-sev-info)">{row.counts.info}</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>

    {#if app.capture}
      {@const c = app.capture}
      <div class="grid gap-3 lg:grid-cols-3">
        <section class="panel flex flex-col min-h-0">
          <h2 class="panel-head">vantages</h2>
          <div class="flex-1 overflow-auto">
            <table class="tbl">
              <thead>
                <tr><th>kind</th><th>observer</th><th class="text-right">offset</th><th class="text-right">events</th></tr>
              </thead>
              <tbody>
                {#each c.vantages as v (v.source)}
                  <tr>
                    <td class="text-dim">{v.kind}</td>
                    <td title={v.observer || v.source}>{v.observer ? shortPeer(v.observer) : v.source}</td>
                    <td class="text-right text-faint">{Math.round(v.offset)}ms</td>
                    <td class="text-right">{v.events.length}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </section>

        <section class="panel flex flex-col min-h-0">
          <h2 class="panel-head">rooms</h2>
          {#if c.rooms.size === 0}
            <p class="p-2.5 text-faint text-[11px]">No room refs in this capture.</p>
          {:else}
            <div class="flex-1 overflow-auto">
              <table class="tbl">
                <thead>
                  <tr><th>ref</th><th>kind</th><th class="text-right">observers</th><th class="text-right">events</th></tr>
                </thead>
                <tbody>
                  {#each [...c.rooms.values()] as r (r.key)}
                    <tr>
                      <td title={r.key}>{r.ref}</td>
                      <td class="text-dim">{r.kind}</td>
                      <td class="text-right">{r.observers.length}</td>
                      <td class="text-right">{r.eventCount}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
            <p class="border-t border-line/50 p-1.5 text-[10px] text-faint leading-relaxed">
              Refs are bundle-local. The room code is the only membership secret.
            </p>
          {/if}
        </section>

        <section class="panel flex flex-col min-h-0">
          <h2 class="panel-head">capture warnings</h2>
          {#if c.warnings.length === 0}
            <p class="p-2.5 text-faint text-[11px]">None.</p>
          {:else}
            <ul class="flex-1 overflow-auto flex flex-col gap-1 p-2.5">
              {#each c.warnings as w, i (i)}
                <li class="text-[11px]" style="color: var(--color-sev-warn)">{w}</li>
              {/each}
            </ul>
          {/if}
        </section>
      </div>
    {/if}
  </div>
{/if}
