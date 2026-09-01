<!--
  PeerDetail: everything one peer did, from every vantage that saw it.

  The panels answer the four questions a peer bug raises in order: what did each
  observer believe about it, how did its transport behave, what did voice do,
  and what did the SFU hold for it.
-->
<script lang="ts">
  import {
    app,
    counterSeries,
    eventsForPeer,
    fmtClock,
    fmtDate,
    fmtDetail,
    fmtDur,
    goTo,
    linkAt,
    linkColor,
    observersWithVantage,
    rttSeries,
    selectPeer,
    sevColor,
    sfuSnapshots,
    shortPeer,
  } from "$lib/sources.svelte";

  /** Kinds that move a peer from one state to another, as opposed to sampling it. */
  const TRANSITIONS: Readonly<Record<string, true>> = {
    "peer.dial.start": true,
    "peer.dial.ok": true,
    "peer.dial.fail": true,
    "peer.connect": true,
    "peer.disconnect": true,
    "peer.relayed": true,
    "peer.direct": true,
    "peer.upgrade.attempt": true,
    "peer.upgrade.ok": true,
    "peer.upgrade.fail": true,
    "peer.drop.liveness": true,
    "peer.redial": true,
    "stream.open": true,
    "stream.open.fail": true,
    "stream.proven": true,
    "stream.lost": true,
    "stream.confirm.fail": true,
    "stream.reset": true,
  };

  const peer = $derived(app.selectedPeer);
  const rows = $derived(peer ? eventsForPeer(peer.peerId) : []);
  const transitions = $derived(rows.filter((r) => TRANSITIONS[r.e.kind] === true));
  const voiceHistory = $derived(
    rows.filter((r) => r.e.kind === "voice.pc.state" || r.e.kind === "voice.ice.state")
  );
  const iceEvents = $derived(
    rows.filter((r) => r.e.kind.startsWith("ice.") || r.e.kind === "voice.ice.connected")
  );
  const counters = $derived(peer ? counterSeries(peer.peerId) : []);
  const rtt = $derived(peer ? rttSeries(peer.peerId) : []);

  /** The unbroken runs of a measured round trip. A lost probe breaks the line. */
  const rttPath = $derived.by(() => {
    const pts = rtt.filter((s) => s.ms !== null);
    if (pts.length < 2) return { path: "", max: 0, lost: rtt.filter((s) => s.ms === null).length };
    const max = Math.max(...pts.map((s) => s.ms ?? 0), 1);
    const t0 = pts[0].at;
    const span = Math.max(1, pts[pts.length - 1].at - t0);
    const segments: string[] = [];
    let open = false;
    for (const s of rtt) {
      if (s.ms === null) {
        open = false;
        continue;
      }
      const x = ((s.at - t0) / span) * 300;
      const y = 40 - (s.ms / max) * 36;
      segments.push(`${open ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`);
      open = true;
    }
    return { path: segments.join(" "), max, lost: rtt.filter((s) => s.ms === null).length };
  });

  const snapshots = $derived(sfuSnapshots());
  const ownSnapshot = $derived(
    peer ? [...snapshots].reverse().find((s) => s.self.peerId === peer.peerId) : undefined
  );
  const siblingProducers = $derived.by(() => {
    if (!peer) return [];
    for (const s of [...snapshots].reverse()) {
      const hit = s.room.find((r) => r.peerId === peer.peerId);
      if (hit) return hit.producers;
    }
    return [];
  });
</script>

{#if !app.capture}
  <p class="text-dim">
    No capture selected. Pick one in
    <button class="text-key underline" onclick={() => goTo("sessions")}>Sessions</button>.
  </p>
{:else}
  <div class="grid gap-3 lg:grid-cols-[13rem_1fr]">
    <!-- Picker -->
    <nav class="panel h-fit">
      <h2 class="panel-head">peers {app.peers.length}</h2>
      <ul>
        {#each app.peers as p (p.peerId)}
          <li>
            <button
              class="flex w-full items-baseline gap-1.5 px-2 py-0.5 text-left font-mono text-[11px]
                     {peer?.peerId === p.peerId ? 'bg-raise' : 'hover:bg-raise'}"
              onclick={() => selectPeer(p.peerId)}
              title={p.peerId}
            >
              <span style="color: {peer?.peerId === p.peerId ? 'var(--color-key)' : ''}">
                {shortPeer(p.peerId)}
              </span>
              {#if p.hasVantage}
                <span class="text-[9px] text-faint">vantage</span>
              {/if}
            </button>
          </li>
        {/each}
      </ul>
    </nav>

    {#if !peer}
      <p class="text-dim">This capture names no peer.</p>
    {:else}
      <div class="flex min-w-0 flex-col gap-3">
        <!-- Identity -->
        <section class="panel p-2.5">
          <p class="font-mono text-[12px] break-all" style="color: var(--color-key)">
            {peer.peerId}
          </p>
          <dl class="mt-1 grid gap-x-4 gap-y-0.5 font-mono text-[11px] sm:grid-cols-2">
            <div><span class="text-faint">first seen </span>{fmtDate(peer.firstSeen)}</div>
            <div><span class="text-faint">last seen </span>{fmtDate(peer.lastSeen)}</div>
            <div>
              <span class="text-faint">alive for </span>{fmtDur(peer.lastSeen - peer.firstSeen)}
            </div>
            <div>
              <span class="text-faint">vantage </span>{peer.hasVantage ? "yes" : "no"}
            </div>
            <div class="sm:col-span-2">
              <span class="text-faint">named by </span>{peer.observers
                .map((o) => shortPeer(o))
                .join(", ")}
            </div>
            <div class="sm:col-span-2">
              <span class="text-faint">identity refs </span>{peer.identityRefs.length === 0
                ? "none proven"
                : peer.identityRefs.join(", ")}
            </div>
          </dl>
          {#if peer.identityRefs.length > 1}
            <p class="mt-1 text-[11px]" style="color: var(--color-sev-warn)">
              Two bundles gave this peer different identity ordinals. An ordinal is
              bundle-local, so that is expected and joins nothing.
            </p>
          {/if}
        </section>

        <!-- What each witness believes right now -->
        <section class="panel">
          <h2 class="panel-head">
            link state at {fmtClock(app.at)}
          </h2>
          <table class="tbl">
            <thead>
              <tr><th>observer</th><th>state</th><th>voice</th><th>media</th><th>proven</th></tr>
            </thead>
            <tbody>
              {#each observersWithVantage() as o (o)}
                {#if o !== peer.peerId}
                  {@const l = linkAt(o, peer.peerId)}
                  <tr>
                    <td title={o}>{shortPeer(o)}</td>
                    <td style="color: {linkColor(l?.state ?? 'none')}">{l?.state ?? "none"}</td>
                    <td class="text-dim">{l?.voice ?? "none"}</td>
                    <td class="text-dim">{l?.media ?? "none"}</td>
                    <td class="text-dim">{l?.proven ? "yes" : "no"}</td>
                  </tr>
                {/if}
              {/each}
            </tbody>
          </table>
        </section>

        <div class="grid gap-3 xl:grid-cols-2">
          <!-- Transport -->
          <section class="panel">
            <h2 class="panel-head">state transitions {transitions.length}</h2>
            <div class="max-h-64 overflow-auto">
              <table class="tbl">
                <tbody>
                  {#each transitions as r (r.i)}
                    <tr>
                      <td class="whitespace-nowrap">{fmtClock(r.e.at)}</td>
                      <td class="text-dim">{shortPeer(r.e.observer)}</td>
                      <td style="color: {sevColor(r.e.sev)}">{r.e.kind}</td>
                      <td class="text-dim">{fmtDetail(r.e.d)}</td>
                    </tr>
                  {/each}
                  {#if transitions.length === 0}
                    <tr><td class="text-faint">No transport transition recorded.</td></tr>
                  {/if}
                </tbody>
              </table>
            </div>
          </section>

          <!-- Round trip -->
          <section class="panel">
            <h2 class="panel-head">
              round trip
              <span class="text-faint">
                {rtt.length} probe(s), {rttPath.lost} lost, peak {Math.round(rttPath.max)}ms
              </span>
            </h2>
            {#if rttPath.path === ""}
              <p class="p-2.5 text-faint">
                Fewer than two measured probes. `peer.rtt` is budgeted at two per
                second, so a short capture can hold none.
              </p>
            {:else}
              <svg viewBox="0 0 300 44" class="w-full p-2" role="img" aria-label="round trip series">
                <line x1="0" y1="40" x2="300" y2="40" stroke="var(--color-line)" />
                <path d={rttPath.path} fill="none" stroke="var(--color-ls-direct)" stroke-width="1.5" />
              </svg>
            {/if}
          </section>

          <!-- Voice -->
          <section class="panel">
            <h2 class="panel-head">voice state history {voiceHistory.length}</h2>
            <div class="flex max-h-48 flex-wrap gap-1 overflow-auto p-2">
              {#each voiceHistory as r (r.i)}
                <span
                  class="chip"
                  style="color: {sevColor(r.e.sev)}"
                  title="{fmtClock(r.e.at)} {r.e.kind} from {shortPeer(r.e.observer)}"
                >
                  {r.e.d?.state ?? r.e.kind}
                </span>
              {/each}
              {#if voiceHistory.length === 0}
                <span class="text-faint">No voice peer connection for this peer.</span>
              {/if}
            </div>
          </section>

          <!-- ICE and TURN -->
          <section class="panel">
            <h2 class="panel-head">ice and turn {iceEvents.length}</h2>
            <div class="max-h-48 overflow-auto">
              <table class="tbl">
                <tbody>
                  {#each iceEvents as r (r.i)}
                    <tr>
                      <td class="whitespace-nowrap">{fmtClock(r.e.at)}</td>
                      <td style="color: {sevColor(r.e.sev)}">{r.e.kind}</td>
                      <td class="text-dim">{fmtDetail(r.e.d)}</td>
                    </tr>
                  {/each}
                  {#if iceEvents.length === 0}
                    <tr>
                      <td class="text-faint">
                        No ICE or TURN event names this peer. A candidate TYPE is
                        only recorded where the transport reports one, so this
                        panel can be empty on a healthy direct link.
                      </td>
                    </tr>
                  {/if}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        <!-- Counters -->
        <section class="panel">
          <h2 class="panel-head">
            counter series {counters.length}
            <span class="text-faint">changed fields only, sampled every 5s</span>
          </h2>
          {#if counters.length === 0}
            <p class="p-2.5 text-faint">
              This peer uploaded no vantage, so it has no counter bag of its own.
            </p>
          {:else}
            <div class="max-h-56 overflow-auto">
              <table class="tbl">
                <tbody>
                  {#each counters as c, i (i)}
                    <tr>
                      <td class="whitespace-nowrap">{fmtClock(c.at)}</td>
                      <td class="text-dim">{fmtDetail(c.d)}</td>
                    </tr>
                  {/each}
                </tbody>
              </table>
            </div>
          {/if}
        </section>

        <!-- SFU -->
        <section class="panel">
          <h2 class="panel-head">
            sfu view
            <span class="text-faint">{snapshots.length} snapshot(s) in this capture</span>
          </h2>

          {#if ownSnapshot}
            <div class="grid gap-2 p-2 xl:grid-cols-3">
              <div>
                <h3 class="font-mono text-[10px] tracking-wider text-faint uppercase">transports</h3>
                <table class="tbl">
                  <tbody>
                    {#each ownSnapshot.self.transports as t (t.dir)}
                      <tr>
                        <td>{t.dir}</td>
                        <td class="text-dim">ice {t.iceState} / dtls {t.dtlsState}</td>
                        <td class="text-faint">
                          {t.tuple ? `${t.tuple.protocol}:${t.tuple.localPort}` : "no tuple"}
                        </td>
                        <td class="text-right text-faint">
                          {t.rtt === null ? "-" : `${Math.round(t.rtt)}ms`}
                        </td>
                      </tr>
                    {/each}
                  </tbody>
                </table>
              </div>
              <div>
                <h3 class="font-mono text-[10px] tracking-wider text-faint uppercase">producers</h3>
                <table class="tbl">
                  <tbody>
                    {#each ownSnapshot.self.producers as p (p.id)}
                      <tr>
                        <td>{p.source}/{p.kind}</td>
                        <td class="text-right text-dim">{p.consumers} viewer(s)</td>
                        <td class="text-right text-faint">{Math.round(p.bitrate / 1000)}kbps</td>
                        <td class="text-right text-faint">{p.packetsLost} lost</td>
                      </tr>
                    {/each}
                    {#if ownSnapshot.self.producers.length === 0}
                      <tr><td class="text-faint">none</td></tr>
                    {/if}
                  </tbody>
                </table>
              </div>
              <div>
                <h3 class="font-mono text-[10px] tracking-wider text-faint uppercase">consumers</h3>
                <table class="tbl">
                  <tbody>
                    {#each ownSnapshot.self.consumers as c (c.id)}
                      <tr>
                        <td>{c.kind}</td>
                        <td class="text-dim">score {c.score}</td>
                        <td class="text-faint">
                          {c.paused ? "paused" : c.producerPaused ? "producer paused" : "live"}
                        </td>
                        <td class="text-right text-faint">{c.packetsLost} lost</td>
                      </tr>
                    {/each}
                    {#if ownSnapshot.self.consumers.length === 0}
                      <tr><td class="text-faint">none</td></tr>
                    {/if}
                  </tbody>
                </table>
              </div>
            </div>
            <p class="border-t border-line/50 px-2 py-1 font-mono text-[10px] text-faint">
              taken {fmtClock(ownSnapshot.takenAt)} · {ownSnapshot.roomPeerCount} in room ·
              {ownSnapshot.self.cumulativeProduces} cumulative produces ·
              {ownSnapshot.self.backpressured ? "BACKPRESSURED" : "no backpressure"}
            </p>
          {:else if siblingProducers.length > 0}
            <table class="tbl">
              <thead>
                <tr><th>producer</th><th>source</th><th class="text-right">viewers</th></tr>
              </thead>
              <tbody>
                {#each siblingProducers as p (p.id)}
                  <tr>
                    <td class="text-faint">{p.id.slice(0, 8)}</td>
                    <td>{p.source}/{p.kind}</td>
                    <td class="text-right">{p.consumers}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
            <p class="border-t border-line/50 px-2 py-1 text-[11px] text-faint">
              This is the sibling view another peer's snapshot carried. It has no
              transport or consumer detail, because the SFU only reports those to
              the peer they belong to.
            </p>
          {:else}
            <p class="p-2.5 text-faint">
              No SFU snapshot names this peer. A snapshot needs SFU_TELEMETRY=1 on
              the SFU and a video or screen call in progress.
            </p>
          {/if}
        </section>
      </div>
    {/if}
  </div>
{/if}
