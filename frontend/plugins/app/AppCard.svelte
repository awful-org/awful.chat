<script lang="ts">
  /**
   * The chat card for an app: which site, what it was started with, who has
   * it open, and - for the person who started it - a way to end it. The app
   * itself only opens as a call tile.
   */
  import { Button } from "$lib/components/ui/button";
  import type { CardProps } from "$lib/plugins/api";
  import { newestCardOf, watchRoomCards } from "$lib/plugins/call-tiles.svelte";
  import { presentPlayers, type AppState } from "./logic";
  import { manifest } from "./manifest";
  import SiteAddress from "./SiteAddress.svelte";
  import SiteIcon from "./SiteIcon.svelte";

  let { card, cardState, host }: CardProps<AppState> = $props();

  // $derived: a const would capture the prop once and miss every update.
  const app = $derived(cardState);
  const mine = $derived(host.selfDid() === app.starter);
  // The clock, ticking while the app runs: someone whose tab closed sends no
  // "leave", and only time passing takes them off the list.
  let now = $state(Date.now());
  $effect(() => {
    if (app.ended) return;
    const tick = setInterval(() => (now = Date.now()), 5_000);
    return () => clearInterval(tick);
  });
  const using = $derived(presentPlayers(app, now));
  let ending = $state(false);

  // A newer app in this room took the call's tile (the host shows only the
  // newest card per plugin), so this one is over even if its starter never
  // said so - someone else's /app cannot end it for them. Which card is the
  // newest comes from the call tiles' own answer, which moves only when a
  // card is stored: asking host.cards() on every card-state change re-read
  // the room's cards for every vote and every heartbeat, from every app
  // card on screen. Watched on the flag, not the state: every heartbeat is
  // a new state object.
  const ended = $derived(app.ended);
  $effect(() => {
    if (ended) return;
    return watchRoomCards(card.roomCode);
  });
  const newest = $derived(newestCardOf(card.roomCode, manifest.id));
  const replaced = $derived(!!newest && newest !== card.id);

  async function end(): Promise<void> {
    if (ending) return;
    ending = true;
    try {
      await host.sendUpdate(card.id, { t: "end" });
    } catch (err) {
      console.error("[app] could not end:", err);
    } finally {
      ending = false;
    }
  }
</script>

<div class="flex w-full flex-col gap-2 font-mono">
  {#if !app.url}
    <p class="text-xs text-muted-foreground">This app can't be opened: its address is missing, not https, or not one an app may use.</p>
  {:else}
    <div class="flex items-center gap-2">
      <SiteIcon url={app.url} class="size-8 text-sm" />
      <!-- Never cut at the end: that is where the site's real name is. -->
      <div class="min-w-0">
        <SiteAddress url={app.url} class="text-sm font-semibold text-foreground" />
        <SiteAddress url={app.url} path class="text-[11px] text-muted-foreground" />
      </div>
    </div>
    {#if app.args}
      <p class="text-xs text-muted-foreground">
        Started with <code class="rounded bg-muted px-1 py-0.5 text-foreground">{app.args}</code>
      </p>
    {/if}
    {#if app.ended}
      <p class="text-xs text-muted-foreground">Ended.</p>
    {:else if replaced}
      <p class="text-xs text-muted-foreground">Replaced by a newer app.</p>
    {:else}
      <p class="text-xs text-muted-foreground">
        {#if using.length}
          {using.map((p) => p.name).join(", ")}
          {using.length === 1 ? "has" : "have"} it open.
        {/if}
        It runs in the call, as a tile.
      </p>
      {#if mine}
        <Button
          variant="outline"
          size="sm"
          class="self-start font-mono text-xs cursor-pointer"
          disabled={ending}
          onclick={end}>{ending ? "Ending..." : "End for everyone"}</Button
        >
      {/if}
    {/if}
  {/if}
</div>
