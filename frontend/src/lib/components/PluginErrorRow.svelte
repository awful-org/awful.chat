<script lang="ts">
  /**
   * One "only you can see this" note from a plugin, in the chat flow where
   * the person was looking when they ran it. Host-drawn, so a plugin only
   * chooses the words.
   */
  import { X } from "@lucide/svelte";
  import PluginIcon from "$lib/plugins/PluginIcon.svelte";
  import { getManifest } from "$lib/plugins/registry";
  import { dismissPluginError, type PluginErrorEntry } from "$lib/plugins/plugin-errors.svelte";

  let { entry }: { entry: PluginErrorEntry } = $props();
  const manifest = $derived(getManifest(entry.pluginId));
</script>

<div
  role="alert"
  class="my-1.5 flex max-w-xl items-start gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 font-mono"
>
  <PluginIcon icon={manifest?.icon ?? "lucide:unplug"} class="mt-0.5 size-4 shrink-0 text-destructive" />
  <div class="min-w-0 flex-1">
    <p class="text-xs">
      <span class="font-semibold text-foreground">{manifest?.name ?? entry.pluginId}</span>
      <span class="text-muted-foreground"> · only you can see this</span>
    </p>
    <p class="mt-0.5 whitespace-pre-wrap break-words text-sm text-foreground">{entry.message}</p>
  </div>
  <button
    type="button"
    onclick={() => dismissPluginError(entry.id)}
    aria-label="Dismiss"
    class="shrink-0 cursor-pointer rounded p-0.5 text-muted-foreground hover:bg-muted hover:text-foreground"
  >
    <X class="size-3.5" />
  </button>
</div>
