<script lang="ts">
  import { _transport, transportState } from "$lib/transport/transport.svelte";
  import type { TransportStatus } from "$lib/transport/types";
  import { isConfigured } from "$lib/runtime-config";
  import { CircleAlert, ServerOff, WifiOff, X } from "@lucide/svelte";
  import { onDestroy, onMount } from "svelte";

  /**
   * The things the app has to say to everybody, whatever their settings.
   *
   * TransportStatus is debug chrome: every announcement it renders is behind
   * displayPrefs.showConnectionInfo, which is off by default. That is right
   * for "relay dial retry" and wrong for "the browser may delete your
   * identity" - three of the app's `app-warning` announcements are the only
   * warning a user ever gets that their stored data is at risk, and nobody
   * had that switch on, so nobody saw them. They surface here instead, with
   * no switch in front of them, and TransportStatus keeps the debug feed.
   *
   * One component for both the toasts and the connectivity bar because they
   * are the same piece of screen: two independently positioned fixed layers
   * above the composer would sit on top of each other. The bar is the floor
   * of the stack, toasts pile up above it.
   */

  interface Notice {
    id: number;
    message: string;
    /** Stays until dismissed. See STICKY. */
    sticky: boolean;
  }

  /**
   * Warnings that must not disappear on their own.
   *
   * `app-warning` carries no severity field, so this matches on the message.
   * The distinction is real, though: a warning about stored data is a thing
   * the user has to go and DO something about, and one that fades after eight
   * seconds while their phone is in a pocket has told nobody anything. The
   * transient ones - a screen share whose audio dropped and came back - are
   * about a state that is already visible elsewhere and are gone by the time
   * anyone would act on them, so they time out.
   *
   * When app-warning grows a severity, delete this and read that instead.
   */
  const STICKY = [
    /storage is not protected/i,
    /damaged \d+ stored records/i,
    /backup file received/i,
  ];

  /** At most this many on screen; the oldest is dropped for a newer one. */
  const MAX_NOTICES = 3;
  const AUTO_DISMISS_MS = 12_000;

  let notices = $state<Notice[]>([]);
  let nextId = 0;
  let online = $state(true);
  let configured = $state(true);

  const relayConnected = $derived(transportState.relayConnected);

  let cleanups: (() => void)[] = [];
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  function dismiss(id: number): void {
    notices = notices.filter((n) => n.id !== id);
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.delete(id);
  }

  function push(message: string): void {
    // The same warning announced twice (a retry, a second tab's storage
    // event) should not stack two identical toasts on top of each other.
    if (notices.some((n) => n.message === message)) return;
    const notice: Notice = {
      id: ++nextId,
      message,
      sticky: STICKY.some((re) => re.test(message)),
    };
    // Drop the OLDEST when full: the newest thing to go wrong is the one the
    // user is looking at the screen for.
    const kept = [...notices, notice].slice(-MAX_NOTICES);
    for (const gone of notices) {
      if (!kept.includes(gone)) dismiss(gone.id);
    }
    notices = kept;
    if (!notice.sticky) {
      timers.set(
        notice.id,
        setTimeout(() => dismiss(notice.id), AUTO_DISMISS_MS)
      );
    }
  }

  onMount(() => {
    online = navigator.onLine;
    // isConfigured() is a plain function, not reactive: it flips once the
    // /config.json load settles, and the load retries itself on `online`.
    // Re-read it wherever connectivity changes rather than polling.
    configured = isConfigured();

    const onOnline = () => {
      online = true;
      configured = isConfigured();
    };
    const onOffline = () => {
      online = false;
    };
    window.addEventListener("online", onOnline);
    window.addEventListener("offline", onOffline);
    cleanups.push(() => window.removeEventListener("online", onOnline));
    cleanups.push(() => window.removeEventListener("offline", onOffline));

    // _transport is a module-level const, built at import: there is no window
    // in which this mounts before it exists, so no null guard.
    const onStatus = (status: TransportStatus) => {
      // relay-reservation-failed is here and not in the debug feed alone
      // because it is the one relay event with no visible symptom: the socket
      // is up, the app looks connected, and nobody can reach this peer
      // through it. The rest of the relay chatter stays in TransportStatus.
      if (
        status.type === "app-warning" ||
        status.type === "relay-reservation-failed"
      ) {
        push(status.message);
      }
    };
    _transport.on("status", onStatus);
    cleanups.push(() => _transport.off("status", onStatus));
  });

  // A relay that connects proves the configuration was read, and a failed
  // load that later succeeds shows up here first.
  $effect(() => {
    if (relayConnected) configured = true;
  });

  onDestroy(() => {
    cleanups.forEach((c) => c());
    timers.forEach((t) => clearTimeout(t));
    timers.clear();
  });

  const barText = $derived.by(() => {
    if (!online) return "Offline. Messages send when you reconnect.";
    if (!configured) return "This instance has no relay configured.";
    return null;
  });
</script>

<!-- Above the composer, and above the home indicator on a phone. Not
     pointer-events-none as a whole: the toasts carry a dismiss button. -->
<div
  class="pointer-events-none fixed inset-x-0 bottom-[calc(5.25rem+env(safe-area-inset-bottom))] z-50
    flex flex-col items-center gap-2
    pl-[max(0.75rem,env(safe-area-inset-left))] pr-[max(0.75rem,env(safe-area-inset-right))]"
>
  {#each notices as notice (notice.id)}
    <div
      role="alert"
      class="pointer-events-auto flex w-full max-w-md items-start gap-2 rounded-lg border border-amber-500/40 bg-background/95 px-3 py-2 text-xs shadow-lg backdrop-blur"
    >
      <CircleAlert class="mt-0.5 size-4 shrink-0 text-amber-500" />
      <span class="min-w-0 flex-1 text-foreground">{notice.message}</span>
      <button
        type="button"
        onclick={() => dismiss(notice.id)}
        aria-label="Dismiss"
        class="-m-1 inline-flex size-9 shrink-0 items-center justify-center rounded text-muted-foreground hover:text-foreground sm:size-6"
      >
        <X class="size-4" />
      </button>
    </div>
  {/each}

  {#if barText}
    <div
      role="status"
      class="pointer-events-auto flex w-full max-w-md items-center justify-center gap-2 rounded-lg border border-border bg-background/95 px-3 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur"
    >
      {#if online}
        <ServerOff class="size-3.5 shrink-0 text-amber-500" />
      {:else}
        <WifiOff class="size-3.5 shrink-0 text-amber-500" />
      {/if}
      <span>{barText}</span>
    </div>
  {/if}
</div>
