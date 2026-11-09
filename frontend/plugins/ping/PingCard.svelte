<script module lang="ts">
  /**
   * Which run is the live one, across every ping card on the page.
   *
   * Module scope on purpose: a card cannot otherwise reach the run started
   * by a different card, and "a new /ping stops the old one" is exactly
   * that reach.
   */
  let activeRun = 0;
</script>

<script lang="ts">
  /**
   * A live round-trip graph, drawn while it measures.
   *
   * Only the person who ran the command probes. Round trips are
   * point-to-point, so their numbers are theirs - a viewer's link to the
   * same peer is a different link. Publishing every sample would be sixty
   * messages per peer, so the run is local and one update carries the
   * summary at the end.
   */
  import { onDestroy, onMount } from "svelte";
  import type { HostApi } from "$lib/plugins/api";
  import {
    BASE_INTERVAL_MS,
    chartCeiling,
    nextInterval,
    PROBE_TIMEOUT_MS,
    packSeries,
    summarize,
    unpackSeries,
    WINDOW_MS,
    type Sample,
    type Stats,
  } from "./logic";
  import type { PingState } from "./index";

  // cardState, not state. That is the name the host passes - so a prop
  // called `state` was simply never populated - and it would have shadowed
  // the $state rune used all through this component.
  let {
    card,
    cardState,
    host,
  }: {
    card: { id: string; timestamp: number };
    cardState: PingState;
    host: HostApi;
  } = $props();

  /** One line each, in the order they were named. */
  const COLORS = ["#22c55e", "#38bdf8", "#f472b6"];

  /**
   * How recently a card must have been posted for it to start measuring.
   *
   * A refresh re-mounts every ping card in the room's history, and each one
   * would happily start its own thirty-second run - so reloading a busy
   * room meant probing every peer that had ever been pinged, all at once.
   * Only a card that has just been posted is a live request.
   */
  const FRESH_CARD_MS = 15_000;

  const isOwner = $derived(cardState.ownerDid === host.selfDid());
  const done = $derived(Object.keys(cardState.results).length > 0);

  let samples = $state<Record<string, Sample[]>>({});
  /**
   * Display only. The effect below WRITES this and must never read it: an
   * effect that reads a piece of state and then assigns to it schedules
   * itself again forever, which is what effect_update_depth_exceeded is.
   */
  let running = $state(false);
  let elapsed = $state(0);
  /**
   * The "already started" guard, deliberately NOT reactive.
   *
   * A plain let is what keeps it out of the effect's dependencies. Asking
   * `running` to be both the guard and the display flag is what crashed
   * this card the moment anyone ran /ping.
   */
  let started = false;
  /** Set only when the component goes away, never by a re-render. */
  let stopped = false;
  /** Set when a newer /ping takes over. Unlike stopped, this still publishes. */
  let superseded = $state(false);

  /**
   * What the chart draws: our own samples while we are the one measuring,
   * and the published series otherwise. A viewer has no samples of their
   * own - the probes ran on somebody else's machine - so without the
   * published series their chart is simply empty.
   */
  const plotted = $derived.by<Record<string, Sample[]>>(() => {
    if (running || Object.keys(samples).length > 0) return samples;
    const out: Record<string, Sample[]> = {};
    for (const t of cardState.targets) {
      out[t.did] = unpackSeries(cardState.series?.[t.did]);
    }
    return out;
  });

  const ceiling = $derived(chartCeiling(Object.values(plotted).flat()));
  /** Viewers do not run probes, so their `running` flag stays false. Until
   * the owner's first answer or final update arrives, say what the blank
   * chart means instead of presenting it as an empty measurement. */
  const awaitingFirstPoint = $derived(
    !done && !superseded && (running || !isOwner) &&
    !Object.values(plotted).some((list) => list.some((sample) => sample.rtt !== null))
  );
  const liveStats = $derived.by(() => {
    const out: Record<string, Stats> = {};
    for (const t of cardState.targets) out[t.did] = summarize(samples[t.did] ?? []);
    return out;
  });
  /** Live while measuring, then whatever was published. */
  const shown = $derived(running || !done ? liveStats : cardState.results);

  // onMount, NOT $effect. An effect re-runs whenever anything it read
  // changes, and this one reads cardState through isOwner and done - which
  // the host recomputes as a fresh object every time any card state folds.
  // The re-run tore the probes down through the effect's cleanup while the
  // "already started" guard blocked them from restarting, so the card sat
  // on "starting..." forever, having measured nothing. A run belongs to the
  // component's lifetime, not to a dependency set.
  onMount(() => {
    // The owner measures once. Everyone else, and every later render of a
    // finished card, just reads.
    if (!isOwner || done || started) return;
    // A refresh re-mounts the whole room's history, and an old card is a
    // record of a measurement, not a request for a new one.
    if (Date.now() - card.timestamp > FRESH_CARD_MS) return;
    started = true;
    // Newest run wins. Three peers at 500ms is already a steady stream of
    // probes; leaving the previous run going means measuring a link while
    // adding traffic to it, which is the one thing the cadence is chosen to
    // avoid.
    const myRun = ++activeRun;
    const supersededNow = () => myRun !== activeRun;
    running = true;
    const startedAt = performance.now();
    const relayed = new Set<string>();

    const probe = async (did: string) => {
      while (
        !stopped &&
        !supersededNow() &&
        performance.now() - startedAt < WINDOW_MS
      ) {
        if (host.isRelayed(did)) relayed.add(did);
        const rtt = await host.ping(did, { timeoutMs: PROBE_TIMEOUT_MS });
        if (stopped || supersededNow()) return;
        const at = performance.now() - startedAt;
        samples = { ...samples, [did]: [...(samples[did] ?? []), { at, rtt }] };
        elapsed = at;
        await new Promise((r) => setTimeout(r, nextInterval(rtt)));
      }
    };

    // All targets on their own clocks: a slow peer must not hold up the
    // cadence of a fast one, which is what a shared loop would do.
    console.log(
      `[ping] probing ${cardState.targets.length} peer(s) for ${WINDOW_MS / 1000}s`
    );
    void Promise.all(cardState.targets.map((t) => probe(t.did))).then(() => {
      // stopped means the card is gone and there is nobody to tell. Being
      // superseded still publishes: the samples taken are real, and a card
      // frozen mid-graph with no numbers looks like it broke.
      if (stopped) return;
      running = false;
      superseded = supersededNow();
      console.log(
        superseded
          ? "[ping] superseded by a newer run, publishing what was measured"
          : "[ping] window closed, publishing summary"
      );
      const results: Record<string, Stats> = {};
      const series: Record<string, ReturnType<typeof packSeries>> = {};
      for (const t of cardState.targets) {
        const mine = samples[t.did] ?? [];
        results[t.did] = summarize(mine);
        series[t.did] = packSeries(mine);
      }
      const update = {
        action: "result",
        results,
        series,
        relayed: [...relayed],
      };
      // Updates are capped at 4KB. The packed series fits a full run from
      // three peers with room to spare, but a cadence change could alter
      // that, and losing the numbers to save the picture is the wrong trade.
      const withSeries = JSON.stringify(update).length < 3800;
      if (!withSeries) {
        console.warn("[ping] series too large to publish, sending stats only");
      }
      void host.sendUpdate(
        card.id,
        withSeries ? update : { ...update, series: {} }
      );
    });

  });

  onDestroy(() => {
    // Leaving the room mid-run stops the probes rather than letting them
    // keep measuring a card nobody is looking at.
    stopped = true;
  });

  /**
   * Samples to an SVG polyline, dropping the gaps that loss leaves.
   *
   * x is measured from the FIRST sample, not from the run's start. The
   * first probe only resolves once it has been answered, so plotting
   * against the run clock left the line starting somewhere inside the chart
   * with dead space to its left.
   */
  function line(list: Sample[]): string {
    const answered = list.filter((s) => s.rtt !== null);
    const origin = answered[0]?.at ?? 0;
    return answered
      .map((s) => {
        const x = (Math.min(s.at - origin, WINDOW_MS) / WINDOW_MS) * 100;
        const y = 100 - Math.min(100, ((s.rtt as number) / ceiling) * 100);
        return `${x.toFixed(2)},${y.toFixed(2)}`;
      })
      .join(" ");
  }

  function ms(v: number | null): string {
    return v === null ? "-" : `${Math.round(v)}ms`;
  }
</script>

<div class="flex flex-col gap-2 rounded-lg border border-border bg-card p-3">
  <div class="flex items-baseline justify-between gap-2">
    <span class="font-mono text-xs font-semibold">Round trip</span>
    <span class="font-mono text-[10px] text-muted-foreground">
      {#if running}
        measuring {Math.round(elapsed / 1000)}s / {WINDOW_MS / 1000}s
      {:else if done}
        {WINDOW_MS / 1000}s window
      {:else if superseded}
        stopped by a newer ping
      {:else if isOwner && Date.now() - card.timestamp <= FRESH_CARD_MS}
        starting...
      {:else if isOwner}
        <!-- An old card after a reload: a record, not a live request. -->
        not measured
      {:else}
        waiting for the result
      {/if}
    </span>
  </div>

  <div class="relative">
    <svg
      viewBox="0 0 100 100"
      preserveAspectRatio="none"
      class="h-28 w-full rounded bg-muted/30"
      role="img"
      aria-label="Round trip over time"
    >
      <!-- A midline, so the shape has something to be read against. -->
      <line
        x1="0"
        y1="50"
        x2="100"
        y2="50"
        stroke="currentColor"
        stroke-opacity="0.12"
        stroke-width="0.4"
      />
      {#each cardState.targets as t, i (t.did)}
        {@const pts = line(plotted[t.did] ?? [])}
        {#if pts}
          <polyline
            points={pts}
            fill="none"
            stroke={COLORS[i % COLORS.length]}
            stroke-width="1"
            vector-effect="non-scaling-stroke"
            stroke-linejoin="round"
          />
        {/if}
      {/each}
    </svg>
    <span
      class="pointer-events-none absolute right-1 top-0.5 font-mono text-[9px] text-muted-foreground"
      >{ceiling}ms</span
    >
    {#if awaitingFirstPoint}
      <div
        role="status"
        class="pointer-events-none absolute inset-0 flex items-center justify-center"
      >
        <span class="rounded bg-background/85 px-2 py-1 font-mono text-xs text-muted-foreground">
          Running…
        </span>
      </div>
    {/if}
  </div>

  <div class="flex flex-col gap-1">
    {#each cardState.targets as t, i (t.did)}
      {@const s = shown[t.did]}
      <div class="flex items-center gap-2 font-mono text-[11px]">
        <span
          class="size-2 shrink-0 rounded-full"
          style="background: {COLORS[i % COLORS.length]}"
        ></span>
        <span class="min-w-0 flex-1 truncate">{t.name}</span>
        {#if cardState.relayed.includes(t.did)}
          <!-- A relayed hop is peer to relay to peer, so it is structurally
               slower. Without saying so the graph looks like their
               connection is bad when the real answer is that we never
               managed a direct one. -->
          <span
            class="shrink-0 rounded bg-amber-500/15 px-1 text-[9px] text-amber-500"
            >relayed</span
          >
        {/if}
        {#if s}
          <span class="shrink-0 text-muted-foreground">
            {ms(s.min)} / <span class="text-foreground">{ms(s.median)}</span> /
            {ms(s.max)}
          </span>
          {#if s.loss > 0}
            <span class="shrink-0 text-destructive"
              >{Math.round(s.loss * 100)}% lost</span
            >
          {/if}
        {/if}
      </div>
    {/each}
    <span class="font-mono text-[9px] text-muted-foreground">
      min / median / max, every {BASE_INTERVAL_MS}ms or slower on a struggling
      link
    </span>
  </div>
</div>
