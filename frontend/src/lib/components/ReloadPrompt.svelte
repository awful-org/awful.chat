<script lang="ts">
  import { useRegisterSW } from "virtual:pwa-register/svelte";
  import { X } from "@lucide/svelte";

  const { needRefresh, updateServiceWorker } = useRegisterSW({
    onRegisteredSW(swUrl, _) {
      console.log(`Service Worker at: ${swUrl}`);
    },
    onRegisterError(error) {
      console.log("SW registration error", error);
    },
  });

  function close() {
    needRefresh.set(false);
  }
</script>

{#if $needRefresh}
  <div
    class="fixed bottom-4 right-4 z-50 flex items-center gap-3 rounded-lg border border-zinc-700 bg-zinc-900 px-4 py-3 text-sm text-zinc-200 shadow-lg"
    role="alert"
  >
    <span>New version available</span>
    <button
      class="rounded-md bg-zinc-100 px-3 py-1.5 text-xs font-medium text-zinc-900 transition-colors hover:bg-zinc-200"
      onclick={() => updateServiceWorker()}
    >
      Reload
    </button>
    <button
      class="text-zinc-500 hover:text-zinc-300"
      onclick={close}
      aria-label="Close"
    >
      <X size={16} />
    </button>
  </div>
{/if}
