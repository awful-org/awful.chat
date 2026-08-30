<script lang="ts">
  import { onMount } from "svelte";
  import { X } from "@lucide/svelte";
  import type { PluginComponent } from "$lib/plugins/api";
  import type { LocalPluginCardEntry } from "$lib/plugins/local-cards.svelte";
  import { closeLocalCard } from "$lib/plugins/local-cards.svelte";
  import { getManifest, getPlugin } from "$lib/plugins/registry";
  import { makeHostApi } from "$lib/plugins/host";
  import PluginIcon from "$lib/plugins/PluginIcon.svelte";

  let { entry }: { entry: LocalPluginCardEntry } = $props();
  let component = $state<PluginComponent | null>(null);
  let failed = $state(false);
  const manifest = $derived(getManifest(entry.pluginId));
  const host = $derived(makeHostApi(entry.pluginId, entry.roomCode));

  onMount(() => {
    void getPlugin(entry.pluginId).then((plugin) => {
      component = plugin?.localCard ?? null;
      failed = !component;
    });
  });
</script>

<div class="ml-auto mt-3 w-full max-w-2xl rounded-lg border border-primary/25 bg-card shadow-sm">
  <div class="flex items-center gap-2 border-b border-border/70 px-3 py-2">
    <PluginIcon icon={manifest?.icon ?? "lucide:plug"} class="size-4" />
    <span class="min-w-0 flex-1 truncate text-xs font-semibold">
      {manifest?.name ?? entry.pluginId}
    </span>
    <span class="rounded bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] uppercase text-primary">
      Only you
    </span>
    <button
      type="button"
      class="cursor-pointer rounded p-1 text-muted-foreground hover:text-foreground"
      aria-label="Close private plugin card"
      onclick={() => closeLocalCard(entry.id)}
    >
      <X class="size-3.5" />
    </button>
  </div>
  <div class="p-3">
    {#if component}
      {@const LocalCard = component}
      <LocalCard localCard={entry} {host} close={() => closeLocalCard(entry.id)} />
    {:else if failed}
      <p class="text-xs text-muted-foreground">This private plugin surface is unavailable.</p>
    {:else}
      <p class="animate-pulse text-xs text-muted-foreground">Loading...</p>
    {/if}
  </div>
</div>
