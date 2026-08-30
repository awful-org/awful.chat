<script lang="ts">
  /**
   * Chat-card chrome for one anime party: title, cover, membership, and the
   * host-departure grace window. The actual player is shared with the call
   * tile - see AnimePartyPlayer.svelte.
   */
  import { onMount, untrack } from "svelte";
  import { Clapperboard, LogIn, LogOut, Users, X } from "@lucide/svelte";
  import type { Message } from "$lib/transport/transport.svelte";
  import type { HostApi } from "$lib/plugins/api";
  import { Tip } from "$lib/plugins/ui";
  import { createHostDepartureGrace, type HostDepartureGrace } from "./host-departure";
  import type { AnimePartyState } from "./logic";
  import AnimePartyPlayer from "./AnimePartyPlayer.svelte";

  let {
    card,
    cardState,
    host,
  }: {
    card: Message;
    cardState: unknown;
    host: HostApi;
  } = $props();

  // $derived, never a const: a const reads the prop once at mount, and
  // every later fold - somebody joining, the host pausing - would render
  // nowhere until the card remounted.
  const party = $derived(cardState as AnimePartyState);
  // untrack: our own DID never changes across this card's life - the same
  // one-time-read pattern the ecosystem's watch-together card uses.
  const selfDid = untrack(() => host.selfDid());
  const isOwner = $derived(party.ownerDid === selfDid);
  const joined = $derived(party.members.has(selfDid));

  let busy = $state(false);

  onMount(() => {
    let grace: HostDepartureGrace | null = null;
    let pollTimer: ReturnType<typeof setInterval> | undefined;
    if (!isOwner) {
      grace = createHostDepartureGrace(party.ownerDid, host.peers, () => {
        void host.sendUpdate(card.id, { action: "host-left" });
      });
      pollTimer = setInterval(() => grace?.observePeers(), 2000);
    }
    const unsubDisconnect = host.onPeerDisconnect(({ did }) => grace?.observeDisconnect(did));
    const unsubBefore = host.onBeforeDisconnect(() => {
      if (!isOwner && joined && !party.closed) {
        host.sendUpdateImmediately(card.id, { action: "leave" });
      }
    });
    return () => {
      unsubDisconnect();
      unsubBefore();
      clearInterval(pollTimer);
      grace?.dispose();
    };
  });

  async function joinParty(): Promise<void> {
    busy = true;
    try {
      await host.sendUpdate(card.id, { action: "join" });
    } finally {
      busy = false;
    }
  }

  async function leaveParty(): Promise<void> {
    busy = true;
    try {
      await host.sendUpdate(card.id, { action: "leave" });
    } finally {
      busy = false;
    }
  }

  async function closeParty(): Promise<void> {
    busy = true;
    try {
      await host.sendUpdate(card.id, { action: "close" });
    } finally {
      busy = false;
    }
  }
</script>

<div class="flex w-full flex-col gap-3">
  <div class="flex items-start gap-3">
    {#if party.coverImageUrl}
      <img
        src={party.coverImageUrl}
        alt=""
        class="h-16 w-11 shrink-0 rounded-sm object-cover"
      />
    {:else}
      <div class="flex h-16 w-11 shrink-0 items-center justify-center rounded-sm bg-muted">
        <Clapperboard class="size-4 text-muted-foreground" />
      </div>
    {/if}
    <div class="flex min-w-0 flex-1 flex-col gap-0.5">
      <span class="truncate font-mono text-sm font-semibold">{party.title}</span>
      <span class="font-mono text-[11px] text-muted-foreground">
        Episode {party.episode}{party.episodeCount ? ` of ${party.episodeCount}` : ""}
        · hosted by {card.senderName}
      </span>
      <span class="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
        <Users class="size-3" />
        {party.members.size} watching
      </span>
    </div>
    {#if isOwner && !party.closed}
      <Tip text="End the party for everyone">
        {#snippet children(props)}
          <button
            {...props}
            onclick={closeParty}
            disabled={busy}
            aria-label="Close party"
            class="rounded-md border border-border p-1.5 hover:bg-accent disabled:opacity-40"
          >
            <X class="size-3.5" />
          </button>
        {/snippet}
      </Tip>
    {/if}
  </div>

  {#if party.closed}
    <p class="font-mono text-xs text-muted-foreground">This party has ended.</p>
  {:else if joined}
    <AnimePartyPlayer {card} {party} {host} />
    {#if !isOwner}
      <button
        onclick={leaveParty}
        disabled={busy}
        class="flex w-fit items-center gap-1.5 rounded-md border border-border px-2.5 py-1 font-mono text-[11px] hover:bg-accent disabled:opacity-40"
      >
        <LogOut class="size-3.5" />
        Leave party
      </button>
    {/if}
  {:else}
    <button
      onclick={joinParty}
      disabled={busy}
      class="flex w-fit items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 font-mono text-xs font-medium text-primary-foreground disabled:opacity-40"
    >
      <LogIn class="size-3.5" />
      Join party
    </button>
  {/if}
</div>
