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
  import { useRegisterSW } from "virtual:pwa-register/svelte";
  import { X } from "@lucide/svelte";

  const primary = !claimed;
  claimed = true;

  const { needRefresh, updateServiceWorker } = primary
    ? useRegisterSW({
        immediate: true,
        onRegisteredSW(swUrl, registration) {
          console.log(`Service Worker at: ${swUrl}`);
          // A long-lived PWA tab only checks for updates on navigation, which a
          // PWA never does - without this poll an update went unseen until the
          // next full reload, days later.
          if (registration) {
            setInterval(() => void registration.update(), 60 * 60 * 1000);
            // A worker already waiting at launch is an update the user was
            // offered and dismissed, and dismissing it only ever meant "not
            // this second". Left unasked it waits forever, because a PWA
            // never navigates and nothing else fires needRefresh again.
            if (registration.waiting) needRefresh.set(true);
          }
        },
        onRegisterError(error) {
          console.log("SW registration error", error);
        },
      })
    : { needRefresh: writable(false), updateServiceWorker: async () => {} };

  function close() {
    needRefresh.set(false);
  }

  // The reload is not instant: skip-waiting -> activate -> controlling ->
  // location.reload(), and on a slow connection that chain takes seconds
  // with zero visible effect - which reads as a dead button.
  let updating = $state(false);
  function update() {
    updating = true;
    void updateServiceWorker();
  }
</script>

{#if $needRefresh}
  <div
    class="fixed bottom-[max(1rem,env(safe-area-inset-bottom))] right-[max(1rem,env(safe-area-inset-right))] z-50 flex items-center gap-3 rounded-lg border bg-background/95 backdrop-blur px-4 py-3 text-sm font-mono text-foreground shadow-lg"
    role="alert"
  >
    <span>New version available</span>
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
