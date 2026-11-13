<script module lang="ts">
  // This component IS the app's service worker registration (see main.ts).
  // App.svelte mounts it above the route switch so the landing page and the
  // locked app register one too; AppView still mounts one of its own. Only
  // the first may register: two registrations each attach their own
  // updatefound listener, and whichever caught the update decided what the
  // user saw - which is how an update sometimes showed no UI at all.
  let claimed = false;
</script>

<script lang="ts">
  import { writable } from "svelte/store";
  import { onDestroy } from "svelte";
  import { watchPwaUpdate } from "$lib/pwa-update";
  import { useRegisterSW } from "virtual:pwa-register/svelte";
  import { X } from "@lucide/svelte";

  const primary = !claimed;
  claimed = true;
  let available = $state(false);
  let destroyed = false;
  let watcher: ReturnType<typeof watchPwaUpdate> | undefined;

  const { needRefresh, updateServiceWorker } = primary
    ? useRegisterSW({
        immediate: true,
        onRegisteredSW(swUrl, registration) {
          console.log(`Service Worker at: ${swUrl}`);
          if (registration && !destroyed) {
            watcher?.dispose();
            watcher = watchPwaUpdate(registration, __APP_BUILD_ID__, (value) => {
              available = value;
            }, navigator.serviceWorker);
          }
        },
        onRegisterError(error) {
          console.log("SW registration error", error);
        },
      })
    : { needRefresh: writable(false), updateServiceWorker: async () => {} };

  // Workbox's signal is only a hint; a waiting worker must pass the build check.
  const unsubscribe = needRefresh.subscribe((value) => {
    if (value) watcher?.refresh();
  });
  onDestroy(() => {
    destroyed = true;
    unsubscribe();
    watcher?.dispose();
  });

  function close() {
    watcher?.dismiss();
    needRefresh.set(false);
  }

  // The reload is not instant: skip-waiting -> activate -> controlling ->
  // location.reload(), and on a slow connection that chain takes seconds
  // with zero visible effect - which reads as a dead button.
  let updating = $state(false);
  let updateError = $state(false);
  async function update() {
    if (!watcher?.isCurrent()) {
      watcher?.refresh();
      return;
    }
    updating = true;
    updateError = false;
    try {
      await updateServiceWorker();
    } catch {
      updating = false;
      updateError = true;
    }
  }
</script>

{#if available}
  <div
    class="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] max-w-[calc(100vw-2rem)] z-50 flex flex-wrap items-center gap-3 rounded-lg border bg-background/95 backdrop-blur px-4 py-3 text-sm font-mono text-foreground shadow-lg"
    role="alert"
  >
    <span>{updateError ? "Update failed. Try again." : "New version available"}</span>
    <button
      class="rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 cursor-pointer disabled:cursor-default disabled:opacity-70"
      onclick={update}
      disabled={updating}
    >
      {#if updating}<span class="animate-pulse">Updating...</span>{:else}Reload{/if}
    </button>
    <button
      class="text-muted-foreground hover:text-foreground cursor-pointer"
      onclick={close}
      aria-label="Close"
    >
      <X size={16} />
    </button>
  </div>
{/if}
