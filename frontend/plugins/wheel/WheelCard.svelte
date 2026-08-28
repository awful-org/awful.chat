<script lang="ts">
  import { Button } from "$lib/components/ui/button";
  import type { Message } from "$lib/transport/transport.svelte";
  import type { HostApi } from "$lib/plugins/api";

  interface Props {
    card: Message;
    cardState: unknown;
    host: HostApi;
  }

  let { card, cardState, host }: Props = $props();

  const wheelState = $derived(
    cardState as {
      question: string;
      options: string[];
      spun: boolean;
      winner: number | null;
      spinnerName: string;
    }
  );

  const seg = $derived(360 / Math.max(wheelState.options.length, 1));

  let sending = $state(false);
  let rotation = $state(0);
  let animating = $state(false);
  /** Whether this card has ever been seen un-spun by this component - a
   *  card that loads already decided snaps into place instead of replaying
   *  the animation on every scroll-by. */
  let sawUnspun = false;

  const SPIN_MS = 3800;
  const reducedMotion =
    typeof matchMedia !== "undefined" &&
    matchMedia("(prefers-reduced-motion: reduce)").matches;

  // The pointer sits at 12 o'clock. Landing the winner's segment center
  // under it after a few full turns; every client computes the same target
  // because the winner itself is deterministic.
  $effect(() => {
    if (!wheelState.spun || wheelState.winner === null) {
      sawUnspun = true;
      return;
    }
    const target = 5 * 360 - (wheelState.winner + 0.5) * seg;
    if (rotation === target) return;
    if (!sawUnspun || reducedMotion) {
      rotation = target; // historical card or reduced motion: no theater
      return;
    }
    animating = true;
    rotation = target;
    setTimeout(() => (animating = false), SPIN_MS + 100);
  });

  async function handleSpin() {
    if (sending || wheelState.spun) return;
    sending = true;
    try {
      await host.sendUpdate(card.id, { action: "spin" });
    } catch (err) {
      console.error("[wheel] failed to send spin:", err);
    } finally {
      sending = false;
    }
  }

  function sliceColor(i: number): string {
    return `hsl(${(i * 137.5) % 360} 62% 52%)`;
  }

  /** SVG arc path for slice i on a circle of radius r around (100,100). */
  function slicePath(i: number): string {
    const a0 = ((i * seg - 90) * Math.PI) / 180;
    const a1 = (((i + 1) * seg - 90) * Math.PI) / 180;
    const r = 96;
    const x0 = 100 + r * Math.cos(a0);
    const y0 = 100 + r * Math.sin(a0);
    const x1 = 100 + r * Math.cos(a1);
    const y1 = 100 + r * Math.sin(a1);
    const large = seg > 180 ? 1 : 0;
    return `M 100 100 L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`;
  }

  function labelTransform(i: number): string {
    const mid = i * seg + seg / 2;
    // Flip labels on the left half so they read outward, not upside down.
    const flip = mid > 90 && mid < 270 ? 180 : 0;
    return `rotate(${mid - 90} 100 100) translate(160 100) rotate(${flip + 90} 0 0)`;
  }

  function labelFor(option: string): string {
    return option.length > 12 ? `${option.slice(0, 11)}…` : option;
  }
</script>

<!-- w-full + centered: the host frame sets the default card size. -->
<div class="flex w-full flex-col items-center gap-3">
  {#if wheelState.question}
    <p class="w-full text-center font-mono text-sm font-semibold text-foreground">
      {wheelState.question}
    </p>
  {/if}
  {#if wheelState.options.length === 0}
    <div class="text-xs text-muted-foreground">No options configured</div>
  {:else}
    <div class="relative">
      <!-- Pointer -->
      <div
        class="absolute -top-1 left-1/2 z-10 -translate-x-1/2"
        style="width: 0; height: 0; border-left: 9px solid transparent; border-right: 9px solid transparent; border-top: 14px solid var(--primary, #00ff88); filter: drop-shadow(0 1px 2px rgba(0,0,0,.5));"
      ></div>
      <svg
        viewBox="0 0 200 200"
        class="size-52"
        style={`transform: rotate(${rotation}deg); transition: ${animating ? `transform ${SPIN_MS}ms cubic-bezier(0.12, 0.8, 0.18, 1)` : "none"};`}
      >
        {#each wheelState.options as option, i (i)}
          <path
            d={slicePath(i)}
            fill={sliceColor(i)}
            stroke="rgba(0,0,0,0.35)"
            stroke-width="1"
            opacity={wheelState.spun && wheelState.winner !== i ? 0.45 : 1}
            style="transition: opacity 400ms ease {SPIN_MS}ms;"
          />
          <text
            transform={labelTransform(i)}
            text-anchor="middle"
            dominant-baseline="middle"
            font-size="11"
            font-family="ui-monospace, monospace"
            font-weight="600"
            fill="white"
            style="paint-order: stroke; stroke: rgba(0,0,0,0.55); stroke-width: 2px;"
          >
            {labelFor(option)}
          </text>
        {/each}
        <circle cx="100" cy="100" r="14" fill="#18181b" stroke="rgba(255,255,255,0.25)" />
      </svg>
    </div>

    {#if !wheelState.spun}
      <Button onclick={handleSpin} disabled={sending} class="font-mono">
        {sending ? "Spinning..." : "Spin"}
      </Button>
      <p class="text-[11px] font-mono text-muted-foreground">
        One spin decides it - first spin wins.
      </p>
    {:else if animating}
      <!-- The wheel already knows where it lands; the humans get to watch. -->
      <p class="text-[11px] font-mono text-muted-foreground">Spinning...</p>
    {:else if wheelState.winner !== null}
      <div class="text-center">
        <div class="font-mono text-sm font-bold text-primary">
          {wheelState.options[wheelState.winner]}
        </div>
        <div class="font-mono text-xs text-muted-foreground">
          Spun by {wheelState.spinnerName}
        </div>
      </div>
    {/if}
  {/if}
</div>
