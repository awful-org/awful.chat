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
  <p class="text-dim">
    No capture yet. Load at least one client bundle in
    <button class="text-key underline" onclick={() => goTo("sources")}>Sources</button>.
  </p>
{:else}
  <div class="flex flex-col gap-3">
    <table class="tbl">
      <thead>
        <tr>
          <th></th>
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
            class="cursor-pointer {sel ? 'bg-raise' : ''}"
            onclick={() => selectCapture(row.capture.id)}
          >
            <td style="color: var(--color-key)">{sel ? "▸" : ""}</td>
            <td>{fmtDate(row.capture.window.from)}</td>
            <td class="text-right text-dim">
              {fmtDur(row.capture.window.to - row.capture.window.from)}
            </td>
            <td>
              {#each row.kinds as k (k)}
                <span class="chip mr-1 text-dim">{k}</span>
              {/each}
              <span class="text-faint">({row.capture.vantages.length} file)</span>
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
            <td>
              <span class="chip mr-1" style="color: var(--color-sev-error)">{row.counts.block}</span>
              <span class="chip mr-1" style="color: var(--color-sev-warn)">{row.counts.warn}</span>
              <span class="chip" style="color: var(--color-sev-info)">{row.counts.info}</span>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>

    {#if app.capture}
      {@const c = app.capture}
      <div class="grid gap-3 lg:grid-cols-3">
        <section class="panel">
          <h2 class="panel-head">vantages</h2>
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
        </section>

        <section class="panel">
          <h2 class="panel-head">rooms</h2>
          {#if c.rooms.size === 0}
            <p class="p-2.5 text-faint">No room ref in this capture.</p>
          {:else}
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
            <p class="border-t border-line/50 p-2 text-[11px] text-faint">
              A ref is bundle-local. "r1" in two bundles names two different
              rooms, because the room code is the room's only membership secret.
            </p>
          {/if}
        </section>

        <section class="panel">
          <h2 class="panel-head">capture warnings</h2>
          {#if c.warnings.length === 0}
            <p class="p-2.5 text-faint">None.</p>
          {:else}
            <ul class="flex flex-col gap-1 p-2.5">
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
