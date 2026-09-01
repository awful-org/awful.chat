<!--
  Topology: the graph at the scrubbed instant.

  Hand-rolled SVG on purpose. A graph library would add a dependency, hide the
  layout and make the picture non-deterministic between runs. Here the layout is
  a function of the peer set alone: peers sort by peerId and sit on one circle,
  the relay is the left pole and the SFU is the right pole. The same capture
  always draws the same picture, so two screenshots can be compared.

  A link is DIRECTED: it is what `from` believed about `to`. That is the whole
  point, so a one-way link must be impossible to mistake for a two-way one:

    two-way  two solid arcs, one bowed each way, each with a filled arrowhead
    one-way  a single DASHED arc with a HOLLOW arrowhead, plus a dotted stub
             with an ✕ from the silent peer, but only when that peer uploaded a
             vantage. Without a vantage its silence is ignorance, not evidence.
-->
<script lang="ts">
  import type {
    LinkState,
    MediaLinkState,
    TopologyNode,
    VoiceLinkState,
  } from "$lib/analysis/topology";
  import { app, fmtClock, goTo, linkColor, scrubTo, shortPeer } from "$lib/sources.svelte";

  interface Pt {
    x: number;
    y: number;
  }

  const W = 1000;
  const H = 470;
  const CX = 500;
  const CY = 235;
  const NODE_R = 10;
  /** How far a peer-to-peer arc bows off the chord, so the reverse arc clears it. */
  const BOW = 26;

  const VOICE_COLOR: Record<VoiceLinkState, string> = {
    none: "var(--color-ls-none)",
    new: "var(--color-sev-info)",
    connected: "var(--color-ls-proven)",
    relayed: "var(--color-ls-relayed)",
    degraded: "var(--color-sev-warn)",
    stalled: "var(--color-sev-warn)",
    failed: "var(--color-sev-error)",
    "torn-down": "var(--color-faint)",
  };

  const LINK_STATES: readonly LinkState[] = [
    "none",
    "dialing",
    "dial-failed",
    "relayed",
    "direct",
    "proven",
    "lost",
    "dropped",
  ];

  const topo = $derived(app.topology);

  /**
   * The peers to draw.
   *
   * `Topology.nodes` names `self` separately and omits it, because a peer's
   * online state is derived FROM self's point of view. A graph without its own
   * observer is unreadable, so self is added back here. Server ids are dropped:
   * the relay and the SFU are poles, never peers.
   */
  const nodes = $derived.by<TopologyNode[]>(() => {
    const t = topo;
    if (!t) return [];
    const out = t.nodes.filter((n) => !app.serverIds.has(n.peerId));
    if (t.self !== "" && !out.some((n) => n.peerId === t.self)) {
      out.push({
        peerId: t.self,
        identityRef: null,
        rooms: [],
        // Self is the observer. It is never "offline" from its own point of view.
        online: true,
        connecting: false,
      });
    }
    return out;
  });

  /** Deterministic: sort by peerId, then rotate so `self` sits at the top. */
  const placed = $derived.by(() => {
    const t = topo;
    const out = new Map<string, Pt>();
    if (!t) return out;
    const ids = nodes.map((n) => n.peerId).sort();
    const n = ids.length;
    if (n === 0) return out;
    if (n === 1) {
      out.set(ids[0], { x: CX, y: CY });
      return out;
    }
    const radius = n <= 6 ? 150 : 190;
    const selfAt = Math.max(0, ids.indexOf(t.self));
    ids.forEach((id, i) => {
      const step = (((i - selfAt) % n) + n) % n;
      const angle = -Math.PI / 2 + (2 * Math.PI * step) / n;
      out.set(id, {
        x: CX + radius * Math.cos(angle),
        y: CY + radius * Math.sin(angle),
      });
    });
    return out;
  });

  /**
   * A quadratic arc from `a` to `b`, trimmed clear of both node circles and
   * bowed to the LEFT of the a→b direction. The reverse call bows the other
   * way, which is what separates the two directions of one pair.
   */
  function arcOf(a: Pt, b: Pt, bow: number, trim: number) {
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const ux = dx / len;
    const uy = dy / len;
    const p0 = { x: a.x + ux * trim, y: a.y + uy * trim };
    const p1 = { x: b.x - ux * trim, y: b.y - uy * trim };
    const c = {
      x: (p0.x + p1.x) / 2 - uy * bow,
      y: (p0.y + p1.y) / 2 + ux * bow,
    };
    return {
      d: `M${p0.x} ${p0.y} Q${c.x} ${c.y} ${p1.x} ${p1.y}`,
      tip: p1,
      tan: { x: p1.x - c.x, y: p1.y - c.y },
      // The curve's own midpoint, for a badge that must sit on the line.
      mid: { x: (p0.x + 2 * c.x + p1.x) / 4, y: (p0.y + 2 * c.y + p1.y) / 4 },
    };
  }

  /** An arrowhead triangle at `tip`, aligned with the tangent `tan`. */
  function headOf(tip: Pt, tan: Pt, size = 8): string {
    const l = Math.hypot(tan.x, tan.y) || 1;
    const ux = tan.x / l;
    const uy = tan.y / l;
    const bx = tip.x - ux * size;
    const by = tip.y - uy * size;
    const hx = -uy * size * 0.5;
    const hy = ux * size * 0.5;
    return `${tip.x},${tip.y} ${bx + hx},${by + hy} ${bx - hx},${by - hy}`;
  }

  interface Edge {
    key: string;
    d: string;
    head: string;
    color: string;
    oneWay: boolean;
    state: LinkState;
    voice: VoiceLinkState;
    voicePath: string | null;
    media: MediaLinkState;
    mid: Pt;
    title: string;
  }

  interface Stub {
    key: string;
    d: string;
    at: Pt;
    title: string;
  }

  const drawn = $derived.by(() => {
    const t = topo;
    const edges: Edge[] = [];
    const stubs: Stub[] = [];
    if (!t) return { edges, stubs };

    const live = t.links.filter((l) => l.state !== "none");
    const has = new Set(live.map((l) => `${l.from}|${l.to}`));

    for (const l of live) {
      const a = placed.get(l.from);
      const b = placed.get(l.to);
      if (!a || !b) continue;
      const back = has.has(`${l.to}|${l.from}`);
      const arc = arcOf(a, b, BOW, NODE_R + 4);
      const voiceArc = l.voice === "none" ? null : arcOf(a, b, BOW * 0.45, NODE_R + 4).d;
      edges.push({
        key: `${l.from}|${l.to}`,
        d: arc.d,
        head: headOf(arc.tip, arc.tan),
        color: linkColor(l.state),
        oneWay: !back,
        state: l.state,
        voice: l.voice,
        voicePath: voiceArc,
        media: l.media,
        mid: arc.mid,
        title: `${shortPeer(l.from)} → ${shortPeer(l.to)}: ${l.state}${
          l.voice === "none" ? "" : `, voice ${l.voice}`
        }${l.media === "none" ? "" : `, media ${l.media}`}${back ? "" : " (ONE WAY)"}`,
      });

      // The reverse peer never reported this link. Say so only when it could.
      const reverse = app.peers.find((p) => p.peerId === l.to);
      if (!back && reverse?.hasVantage) {
        const tip = arcOf(b, a, BOW, NODE_R + 4).tip;
        stubs.push({
          key: `stub-${l.to}|${l.from}`,
          d: `M${b.x} ${b.y} L${b.x + (tip.x - b.x) * 0.3} ${b.y + (tip.y - b.y) * 0.3}`,
          at: { x: b.x + (tip.x - b.x) * 0.36, y: b.y + (tip.y - b.y) * 0.36 },
          title: `${shortPeer(l.to)} never reported a link to ${shortPeer(l.from)}, and it uploaded a vantage.`,
        });
      }
    }
    return { edges, stubs };
  });

  const selfPt = $derived(topo ? placed.get(topo.self) : undefined);

  function nudge(dir: 1 | -1): void {
    const marks = app.keyframes;
    const here = app.at;
    const next =
      dir > 0 ? marks.find((k) => k > here + 0.5) : [...marks].reverse().find((k) => k < here - 0.5);
    if (next !== undefined) scrubTo(next);
  }
</script>

{#if !topo}
  <p class="text-dim">
    No capture selected. Pick one in
    <button class="text-key underline" onclick={() => goTo("sessions")}>Sessions</button>.
  </p>
{:else}
  <div class="flex flex-col gap-2">
    <div class="flex flex-wrap items-center gap-2">
      <span class="font-mono text-[11px]" style="color: var(--color-key)">
        {fmtClock(topo.at)}
      </span>
      <button class="btn" onclick={() => nudge(-1)}>◂ keyframe</button>
      <button class="btn" onclick={() => nudge(1)}>keyframe ▸</button>
      <input
        type="range"
        class="min-w-48 flex-1 accent-key"
        aria-label="scrub time"
        min={app.capture?.window.from ?? 0}
        max={app.capture?.window.to ?? 1}
        step="1"
        value={app.at}
        oninput={(e) => scrubTo(Number((e.currentTarget as HTMLInputElement).value))}
      />
      <button class="btn" onclick={() => goTo("timeline")}>Open timeline</button>
    </div>

    <div class="panel overflow-hidden">
      <svg viewBox="0 0 {W} {H}" class="w-full" role="img" aria-label="peer topology">
        <!-- Poles -->
        {#if topo.relay}
          {#if selfPt}
            <path
              d={arcOf({ x: 110, y: CY }, selfPt, 0, NODE_R + 4).d}
              fill="none"
              stroke={topo.relay.reserved
                ? "var(--color-ls-proven)"
                : topo.relay.connected
                  ? "var(--color-ls-relayed)"
                  : "var(--color-ls-dial-failed)"}
              stroke-width="1.5"
              stroke-dasharray={topo.relay.connected ? "none" : "4 4"}
            />
          {/if}
          <rect
            x="60"
            y={CY - 26}
            width="100"
            height="52"
            rx="4"
            fill="var(--color-surface)"
            stroke={topo.relay.connected ? "var(--color-ls-proven)" : "var(--color-ls-dial-failed)"}
          />
          <text x="110" y={CY - 8} text-anchor="middle" class="fill-dim text-[11px]">relay</text>
          <text x="110" y={CY + 6} text-anchor="middle" class="fill-text text-[11px]">
            {shortPeer(topo.relay.peerId)}
          </text>
          <text
            x="110"
            y={CY + 19}
            text-anchor="middle"
            class="text-[10px]"
            fill={topo.relay.reserved ? "var(--color-ls-proven)" : "var(--color-sev-warn)"}
          >
            {topo.relay.reserved ? "reserved" : "no reservation"}
          </text>
        {/if}

        {#if topo.sfu}
          {#if selfPt}
            <path
              d={arcOf({ x: W - 110, y: CY }, selfPt, 0, NODE_R + 4).d}
              fill="none"
              stroke={topo.sfu.connected
                ? "var(--color-ls-direct)"
                : "var(--color-ls-dial-failed)"}
              stroke-width="1.5"
              stroke-dasharray={topo.sfu.connected ? "none" : "4 4"}
            />
          {/if}
          <rect
            x={W - 170}
            y={CY - 26}
            width="120"
            height="52"
            rx="4"
            fill="var(--color-surface)"
            stroke={topo.sfu.connected ? "var(--color-ls-direct)" : "var(--color-ls-dial-failed)"}
          />
          <text x={W - 110} y={CY - 8} text-anchor="middle" class="fill-dim text-[11px]">sfu</text>
          <text x={W - 110} y={CY + 6} text-anchor="middle" class="fill-text text-[11px]">
            {topo.sfu.host || "unset"}
          </text>
          <text x={W - 110} y={CY + 19} text-anchor="middle" class="fill-faint text-[10px]">
            {topo.sfu.roomPeerCount === null ? "no snapshot" : `${topo.sfu.roomPeerCount} in room`}
          </text>
        {/if}

        <!-- Silent reverse direction -->
        {#each drawn.stubs as s (s.key)}
          <g>
            <title>{s.title}</title>
            <path
              d={s.d}
              fill="none"
              stroke="var(--color-sev-error)"
              stroke-width="1.25"
              stroke-dasharray="2 4"
            />
            <text
              x={s.at.x}
              y={s.at.y + 4}
              text-anchor="middle"
              class="text-[13px]"
              fill="var(--color-sev-error)">✕</text
            >
          </g>
        {/each}

        <!-- Directed links -->
        {#each drawn.edges as e (e.key)}
          <g>
            <title>{e.title}</title>
            <path
              d={e.d}
              fill="none"
              stroke={e.color}
              stroke-width={e.oneWay ? 2 : 1.75}
              stroke-dasharray={e.oneWay ? "6 4" : "none"}
            />
            <polygon
              points={e.head}
              fill={e.oneWay ? "var(--color-ink)" : e.color}
              stroke={e.color}
              stroke-width="1.25"
            />
            {#if e.voicePath}
              <path
                d={e.voicePath}
                fill="none"
                stroke={VOICE_COLOR[e.voice]}
                stroke-width="1"
                stroke-dasharray="1 3"
              />
            {/if}
            {#if e.media !== "none"}
              <rect
                x={e.mid.x - 3}
                y={e.mid.y - 3}
                width="6"
                height="6"
                fill={e.media === "flowing" ? "var(--color-ls-proven)" : "var(--color-sev-warn)"}
              />
            {/if}
          </g>
        {/each}

        <!-- Peers -->
        {#each nodes as n (n.peerId)}
          {@const p = placed.get(n.peerId)}
          {#if p}
            {@const isSelf = n.peerId === topo.self}
            <g>
              <title>
                {n.peerId}{isSelf
                  ? " — the primary observer, so its own state is not derived"
                  : ` · ${n.online ? "online" : n.connecting ? "connecting" : "offline"}`} · rooms {n
                  .rooms.length}
              </title>
              <circle
                cx={p.x}
                cy={p.y}
                r={NODE_R}
                fill={isSelf
                  ? "var(--color-ink)"
                  : n.online
                    ? "var(--color-ls-proven)"
                    : "var(--color-ink)"}
                stroke={isSelf
                  ? "var(--color-key)"
                  : n.online
                    ? "var(--color-ls-proven)"
                    : n.connecting
                      ? "var(--color-sev-warn)"
                      : "var(--color-faint)"}
                stroke-width={isSelf ? 3.5 : 1.5}
                stroke-dasharray={!isSelf && n.connecting && !n.online ? "3 3" : "none"}
              />
              <text
                x={p.x}
                y={p.y - NODE_R - 6}
                text-anchor="middle"
                class="text-[11px]"
                fill={isSelf ? "var(--color-key)" : "var(--color-text)"}
              >
                {shortPeer(n.peerId)}{isSelf ? " ◂self" : ""}
              </text>
              {#if n.identityRef}
                <text
                  x={p.x}
                  y={p.y + NODE_R + 13}
                  text-anchor="middle"
                  class="fill-faint text-[10px]">{n.identityRef}</text
                >
              {/if}
            </g>
          {/if}
        {/each}
      </svg>
    </div>

    <!-- Legend -->
    <div class="panel flex flex-wrap items-center gap-x-4 gap-y-1 p-2">
      {#each LINK_STATES as s (s)}
        <span class="flex items-center gap-1 font-mono text-[10px] text-dim">
          <svg width="22" height="6" aria-hidden="true"
            ><line x1="0" y1="3" x2="22" y2="3" stroke={linkColor(s)} stroke-width="2" /></svg
          >
          {s}
        </span>
      {/each}
      <span class="flex items-center gap-1 font-mono text-[10px]" style="color: var(--color-sev-error)">
        <svg width="22" height="6" aria-hidden="true"
          ><line
            x1="0"
            y1="3"
            x2="22"
            y2="3"
            stroke="var(--color-sev-error)"
            stroke-width="2"
            stroke-dasharray="6 4"
          /></svg
        >
        dashed + hollow head + ✕ = one way
      </span>
      <span class="font-mono text-[10px] text-faint">
        thin dotted = voice · square = media
      </span>
    </div>
  </div>
{/if}
