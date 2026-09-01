<!--
  Findings: the deterministic engine's answer, grouped by severity.

  A finding names WHAT and WHERE. It never guesses WHY: that is the AI tab's
  job, which is why every row carries the rule's `aiHint` beside its remedy.
  Every evidence chip jumps the Timeline to the exact event that justified it.
-->
<script lang="ts">
  import { RULES } from "$lib/analysis/rules";
  import type { Finding } from "$lib/analysis/findings";
  import {
    app,
    fmtClock,
    fmtDetail,
    focusTimelineIndex,
    goTo,
    severityColor,
    shortPeer,
  } from "$lib/sources.svelte";

  const GROUPS: ReadonlyArray<{ sev: Finding["severity"]; label: string; blurb: string }> = [
    { sev: "block", label: "blocking", blurb: "The session cannot work until one of these is fixed." },
    { sev: "warn", label: "warning", blurb: "The session works, but a failure mode is active." },
    { sev: "info", label: "context", blurb: "Read these before you trust the rest." },
  ];

  function subject(f: Finding): string {
    const s = f.subject;
    if (s.pair) return `${shortPeer(s.pair[0])} → ${shortPeer(s.pair[1])}`;
    if (s.peer) return shortPeer(s.peer);
    if (s.room) return `room ${s.room}`;
    if (s.vantage) return s.vantage;
    return "capture";
  }
</script>

{#if !app.capture}
  <p class="text-dim">
    No capture selected. Pick one in
    <button class="text-key underline" onclick={() => goTo("sessions")}>Sessions</button>.
  </p>
{:else if app.findings.length === 0}
  <div class="panel p-4">
    <p style="color: var(--color-key)">No rule fired on this capture.</p>
    <p class="mt-1 text-dim">
      That is a real answer, not an empty state: the engine is deterministic. If
      the bug is in this capture, either the recorder did not see it or a rule is
      missing. Check <button class="text-key underline" onclick={() => goTo("timeline")}
        >Timeline</button
      > for error-severity events the rules do not cover.
    </p>
  </div>
{:else}
  <div class="flex flex-col gap-4">
    {#each GROUPS as g (g.sev)}
      {@const list = app.findings.filter((f) => f.severity === g.sev)}
      {#if list.length > 0}
        <section class="flex flex-col gap-2">
          <h2 class="flex items-baseline gap-2">
            <span class="font-mono text-[11px] tracking-widest uppercase" style="color: {severityColor(g.sev)}">
              {g.label} · {list.length}
            </span>
            <span class="text-[11px] text-faint">{g.blurb}</span>
          </h2>

          {#each list as f, i (`${f.id}-${i}`)}
            {@const rule = RULES[f.id]}
            <article
              class="panel border-l-2 p-2.5"
              style="border-left-color: {severityColor(f.severity)}"
            >
              <header class="flex flex-wrap items-baseline gap-x-2">
                <h3 class="font-mono text-[12px]" style="color: {severityColor(f.severity)}">
                  {rule?.title ?? f.id}
                </h3>
                <code class="text-[10px] text-faint">{f.id}</code>
                <span class="chip text-dim">{subject(f)}</span>
              </header>

              {#if rule}
                <dl class="mt-1.5 grid gap-x-3 gap-y-0.5 sm:grid-cols-[5.5rem_1fr]">
                  <dt class="font-mono text-[10px] tracking-wider text-faint uppercase">means</dt>
                  <dd>{rule.meaning}</dd>
                  <dt class="font-mono text-[10px] tracking-wider text-faint uppercase">fix</dt>
                  <dd style="color: var(--color-key)">{rule.remedy}</dd>
                  <dt class="font-mono text-[10px] tracking-wider text-faint uppercase">ask ai</dt>
                  <dd class="text-dim">{rule.aiHint}</dd>
                </dl>
              {/if}

              {#if Object.keys(f.detail).length > 0}
                <p class="mt-1.5 font-mono text-[11px] text-dim">{fmtDetail(f.detail)}</p>
              {/if}

              {#if f.evidence.length > 0}
                <div class="mt-1.5 flex flex-wrap items-center gap-1">
                  <span class="font-mono text-[10px] tracking-wider text-faint uppercase">
                    evidence
                  </span>
                  {#each f.evidence.slice(0, 24) as idx (idx)}
                    {@const e = app.capture?.timeline[idx]}
                    <button
                      class="btn"
                      title={e ? `${e.kind} ${fmtDetail(e.d)}` : `timeline index ${idx}`}
                      onclick={() => focusTimelineIndex(idx)}
                    >
                      {e ? `${fmtClock(e.at)} ${e.kind}` : `#${idx}`}
                    </button>
                  {/each}
                  {#if f.evidence.length > 24}
                    <span class="text-[11px] text-faint">
                      +{f.evidence.length - 24} more
                    </span>
                  {/if}
                </div>
              {/if}
            </article>
          {/each}
        </section>
      {/if}
    {/each}
  </div>
{/if}
