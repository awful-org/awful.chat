<script lang="ts">
  /**
   * Call-tile chrome: click-to-join, like a screen share. Nothing loud
   * renders until a member opts in. Once joined it renders the same
   * AnimePartyPlayer the card does - the tile costs the SFU nothing because
   * content is entirely local; only card state syncs.
   */
  import { untrack } from "svelte";
  import { Clapperboard, LogIn, Users } from "@lucide/svelte";
  import type { HostApi } from "$lib/plugins/api";
  import type { AnimePartyState } from "./logic";
  import AnimePartyPlayer from "./AnimePartyPlayer.svelte";

  let {
    card,
    cardState,
    host,
    chromeVisible,
  }: {
    card: { id: string };
    cardState: unknown;
    host: HostApi;
    chromeVisible: boolean;
  } = $props();

  const party = $derived(cardState as AnimePartyState);
  // untrack: our own DID never changes across this tile's life - the same
  // one-time-read pattern the ecosystem's watch-together card uses.
  const selfDid = untrack(() => host.selfDid());
  const joined = $derived(party.members.has(selfDid));

  let joining = $state(false);

  async function joinTile(): Promise<void> {
    joining = true;
    try {
      await host.sendUpdate(card.id, { action: "join" });
    } finally {
      joining = false;
    }
  }
</script>

<div class="flex size-full flex-col gap-2 p-2">
  {#if party.closed}
    <div class="flex flex-1 items-center justify-center font-mono text-xs text-white/70">
      This party has ended.
    </div>
  {:else if joined}
    <div class="pointer-events-auto flex-1">
      <AnimePartyPlayer {card} {party} {host} {chromeVisible} />
    </div>
  {:else}
    <button
      onclick={joinTile}
      disabled={joining}
      class="pointer-events-auto flex flex-1 flex-col items-center justify-center gap-2 rounded-md bg-black/40 text-white disabled:opacity-60"
    >
      {#if party.coverImageUrl}
        <img src={party.coverImageUrl} alt="" class="h-20 w-14 rounded-sm object-cover" />
      {:else}
        <Clapperboard class="size-8" />
      {/if}
      <span class="font-mono text-sm font-semibold">{party.title}</span>
      <span class="flex items-center gap-1 font-mono text-[11px] text-white/70">
        <Users class="size-3" />
        {party.members.size} watching · Episode {party.episode}
      </span>
      <span class="flex items-center gap-1.5 rounded-md bg-primary px-3 py-1 font-mono text-xs font-medium text-primary-foreground">
        <LogIn class="size-3.5" />
        Join
      </span>
    </button>
  {/if}
</div>
