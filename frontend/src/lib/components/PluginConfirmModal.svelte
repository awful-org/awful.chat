<script lang="ts">
  import PluginIcon from "$lib/plugins/PluginIcon.svelte";
  import {
    pluginConfirmState,
    resolvePluginConfirm,
  } from "$lib/plugins/confirm.svelte";

  // Head of the queue only: one question at a time, the next appears when
  // this one is answered.
  const request = $derived(pluginConfirmState.queue[0] ?? null);
</script>

{#if request}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    class="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4"
    onclick={() => resolvePluginConfirm(request.id, false)}
  >
    <div
      class="w-full max-w-sm rounded-lg border border-border bg-popover p-4 shadow-2xl"
      onclick={(e) => e.stopPropagation()}
      role="alertdialog"
      aria-label={request.title}
      tabindex="-1"
    >
      <!-- Host-drawn provenance line: the PLUGIN asks, and the user must
           see which one - the content below is the plugin's words. -->
      <div
        class="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
      >
        <PluginIcon icon={request.pluginIcon} class="size-3" />
        {request.pluginName} plugin asks
      </div>
      <p class="mb-1 text-sm font-semibold text-foreground">{request.title}</p>
      <p class="mb-4 whitespace-pre-wrap text-xs text-muted-foreground">
        {request.message}
      </p>
      <div class="flex justify-end gap-2">
        <button
          type="button"
          onclick={() => resolvePluginConfirm(request.id, false)}
          class="cursor-pointer rounded border border-border px-3 py-1.5 text-xs hover:bg-muted"
        >
          {request.declineLabel}
        </button>
        <button
          type="button"
          onclick={() => resolvePluginConfirm(request.id, true)}
          class="cursor-pointer rounded bg-primary px-3 py-1.5 text-xs text-primary-foreground hover:bg-primary/90"
        >
          {request.acceptLabel}
        </button>
      </div>
    </div>
  </div>
{/if}
