<script lang="ts">
  import PluginIcon from "$lib/plugins/PluginIcon.svelte";
  import {
    pluginConfirmState,
    resolvePluginConfirm,
  } from "$lib/plugins/confirm.svelte";

  // Head of the queue only: one question at a time, the next appears when
  // this one is answered.
  const request = $derived(pluginConfirmState.queue[0] ?? null);

  // Ticks only while a deadline is on screen, so an idle app schedules
  // nothing. The store owns the actual timeout; this is just the readout.
  let now = $state(Date.now());
  $effect(() => {
    if (!request?.expiresAt) return;
    const timer = setInterval(() => (now = Date.now()), 500);
    return () => clearInterval(timer);
  });
  const secondsLeft = $derived(
    request?.expiresAt
      ? Math.max(0, Math.ceil((request.expiresAt - now) / 1000))
      : null
  );
</script>

{#if request}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <!-- pointer-events-auto is load-bearing, not decoration: bits-ui sets
       `pointer-events: none` on <body> while a modal dialog (Settings) is
       open, and this modal lives OUTSIDE that dialog's portal - so it
       painted on top and captured nothing. z-[100] clears the dialog's
       z-50 content and the plugin settings modal's z-60. -->
  <div
    class="pointer-events-auto fixed inset-0 z-[100] flex items-center justify-center bg-black/60 p-4"
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
      <!-- Every item is EXACTLY 12px tall - the icon by size-3, the text by
           leading-3 - so items-center has two equal boxes to center rather
           than a 12px icon against a text box of inherited line-height.
           Optical centering of a 10px uppercase run (no descenders) inside
           a matching 12px line box is what makes the row read as level. -->
      <div
        class="mb-2 flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-wider text-muted-foreground"
      >
        <PluginIcon icon={request.pluginIcon} class="size-3 shrink-0" />
        <span class="min-w-0 truncate leading-3">
          {request.pluginName} plugin asks
        </span>
        {#if request.fromPeerName}
          <!-- Resolved by the HOST from a DID against this room's peers:
               the plugin cannot put a name here. -->
          <span class="min-w-0 truncate leading-3 text-primary">
            for {request.fromPeerName}
          </span>
        {/if}
        {#if secondsLeft !== null}
          <span class="ml-auto shrink-0 leading-3 tabular-nums">
            {secondsLeft}s
          </span>
        {/if}
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
