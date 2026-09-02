<!--
  Logs: the raw text beside the events its parser produced.

  A template table is a guess about a log line. This view exists so a wrong
  guess is visible: the unmatched count is at the top, an unrecognised line
  survives as a `raw` event, and the raw pane is right there to compare against.
-->
<script lang="ts">
  import {
    LOG_PARSERS,
    app,
    fmtBytes,
    fmtClock,
    fmtDetail,
    focusTimelineIndex,
    goTo,
    logPayload,
    sevColor,
    setParser,
    shortPeer,
    timelineIndexOf,
    type LogParser,
  } from "$lib/sources.svelte";

  let selected = $state<string | null>(null);
  const current = $derived(
    app.logFiles.find((f) => f.id === selected) ?? app.logFiles[0] ?? null
  );
  const payload = $derived(current ? logPayload(current.id) : null);

  /** Enough to read, and small enough that the browser stays responsive. */
  const MAX_LINES = 4000;
  const lines = $derived(payload ? payload.text.split("\n").slice(0, MAX_LINES) : []);
</script>

{#if app.logFiles.length === 0}
  <p class="text-dim">
    No log loaded. Capture one with <code class="text-key">docker logs -t &lt;relay&gt;</code> and
    drop it in <button class="text-key underline" onclick={() => goTo("sources")}>Sources</button>.
    Without <code>-t</code> the parser anchors every line relative to the first
    match and adds a warning.
  </p>
{:else}
  <div class="flex flex-col gap-2">
    <div class="flex flex-wrap items-center gap-2">
      {#each app.logFiles as f (f.id)}
        <button
          class="btn {current?.id === f.id ? 'btn-on' : ''}"
          onclick={() => (selected = f.id)}
        >
          {f.name}
          <span class="text-faint">{f.eventCount}</span>
        </button>
      {/each}
    </div>

    {#if current && payload}
      <div class="flex flex-wrap items-center gap-2">
        <label class="flex items-center gap-1">
          <span class="font-mono text-[10px] tracking-wider text-faint uppercase">parser</span>
          <select
            class="field"
            value={current.parser}
            onchange={(e) =>
              setParser(current.id, (e.currentTarget as HTMLSelectElement).value as LogParser)}
          >
            {#each LOG_PARSERS as p (p.id)}
              <option value={p.id}>{p.label}</option>
            {/each}
          </select>
        </label>
        <span class="chip text-dim">{payload.parsed.events.length} events</span>
        <span
          class="chip"
          style="color: {current.unmatched > 0
            ? 'var(--color-sev-warn)'
            : 'var(--color-ls-proven)'}"
        >
          {current.unmatched} unmatched
        </span>
        <span class="font-mono text-[10px] text-faint">{fmtBytes(current.bytes)}</span>
        {#if lines.length === MAX_LINES}
          <span class="chip" style="color: var(--color-sev-warn)">
            raw pane shows the first {MAX_LINES} lines
          </span>
        {/if}
      </div>

      {#each current.warnings as w, i (i)}
        <p class="text-[11px]" style="color: var(--color-sev-warn)">{w}</p>
      {/each}

      <div class="grid min-h-0 gap-3 xl:grid-cols-2">
        <section class="panel flex min-h-0 flex-col">
          <h2 class="panel-head">raw</h2>
          <pre
            class="max-h-[32rem] overflow-auto p-2 text-[11px] leading-snug whitespace-pre">{#each lines as line, n (n)}<span
                class="text-faint">{String(n + 1).padStart(5)} </span>{line}
{/each}</pre>
        </section>

        <section class="panel flex min-h-0 flex-col">
          <h2 class="panel-head">parsed</h2>
          <div class="max-h-[32rem] overflow-auto">
            <table class="tbl">
              <thead>
                <tr><th>time</th><th>kind</th><th>peer</th><th>detail</th></tr>
              </thead>
              <tbody>
                {#each payload.parsed.events as e, n (n)}
                  {@const raw = e.d?.raw !== undefined}
                  <tr
                    class="cursor-pointer"
                    onclick={() => {
                      const i = timelineIndexOf(e.source, e.seq, e.at);
                      if (i >= 0) focusTimelineIndex(i);
                    }}
                    title={raw ? "This line matched no template. It survives as a raw event." : ""}
                  >
                    <td class="whitespace-nowrap">{fmtClock(e.at)}</td>
                    <td style="color: {raw ? 'var(--color-sev-warn)' : sevColor(e.sev)}">
                      {raw ? "unmatched" : e.kind}
                    </td>
                    <!--
                      This pane shows the PARSER's own output, before the merge
                      resolves a suffix to a full peerId, because a mis-parse is
                      what the operator came here to check.
                    -->
                    <td
                      class="text-dim"
                      title={e.peer ??
                        "The parser saw only a suffix. The merge resolves it against the loaded bundles."}
                    >
                      {e.peer
                        ? shortPeer(e.peer)
                        : typeof e.d?.peerSuffix === "string"
                          ? `…${e.d.peerSuffix}?`
                          : ""}
                    </td>
                    <td class="max-w-[26rem] break-all text-dim">{fmtDetail(e.d)}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          </div>
        </section>
      </div>
    {/if}
  </div>
{/if}
