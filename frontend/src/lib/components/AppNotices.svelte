<script lang="ts">
  import { _transport, transportState } from "$lib/transport/transport.svelte";
  import type { TransportStatus } from "$lib/transport/types";
  import { claimNodeLock } from "$lib/transport/node-lock";
  import { isConfigured } from "$lib/runtime-config";
  import { AppWindow, CircleAlert, MicOff, ServerOff, WifiOff, X } from "@lucide/svelte";
  import {
    getVoiceActiveInputDevice,
    setVoiceInputDevice,
  } from "$lib/transport/voice.svelte";
  import { onDestroy, onMount, untrack } from "svelte";
  import { clockJumped } from "$lib/clock-health";

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
    /** Red for something that failed, amber for something to know. */
    tone: "warning" | "error";
    /** The transport's error slot, mirrored rather than timed (see below). */
    fromErrorSlot?: boolean;
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
    /clock|automatic date and time/i,
  ];

  /** At most this many on screen; the oldest is dropped for a newer one. */
  const MAX_NOTICES = 3;
  const AUTO_DISMISS_MS = 12_000;

  let notices = $state<Notice[]>([]);
  let nextId = 0;
  let online = $state(true);
  let configured = $state(true);

  const relayConnected = $derived(transportState.relayConnected);
  // Another tab of this profile has the node; this one waits for it and can
  // ask for it (node-lock.ts). Nothing else in this tab works until then.
  const heldElsewhere = $derived(transportState.nodeHeldElsewhere);

  let cleanups: (() => void)[] = [];
  const timers = new Map<number, ReturnType<typeof setTimeout>>();

  function dismiss(id: number): void {
    // Closing the mirrored error closes the error: left in the slot, it
    // would come straight back the next time anything re-read it.
    if (notices.some((n) => n.id === id && n.fromErrorSlot)) {
      transportState.error = null;
    }
    notices = notices.filter((n) => n.id !== id);
    const t = timers.get(id);
    if (t) clearTimeout(t);
    timers.delete(id);
  }

  function push(
    message: string,
    opts: { tone?: Notice["tone"]; fromErrorSlot?: boolean } = {}
  ): void {
    // The same warning announced twice (a retry, a second tab's storage
    // event) should not stack two identical toasts on top of each other.
    if (notices.some((n) => n.message === message)) return;
    const notice: Notice = {
      id: ++nextId,
      message,
      // The error slot times itself out (setErrorWithAutoClear); its toast
      // follows the slot, so no second timer here.
      sticky: !!opts.fromErrorSlot || STICKY.some((re) => re.test(message)),
      tone: opts.tone ?? "warning",
      fromErrorSlot: opts.fromErrorSlot,
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
    const sample = () => ({ wall: Date.now(), monotonic: performance.now() });
    let baseline = sample();
    const resetClockSample = () => { baseline = sample(); };
    const clockTimer = setInterval(() => {
      const now = sample();
      if (document.visibilityState === "visible" && clockJumped(baseline, now)) {
        push("Your device clock changed or resumed out of sync. Check automatic date and time. Conversation order is preserved, but displayed times and relay reservations may be affected.");
      }
      baseline = now;
    }, 30_000);
    document.addEventListener("visibilitychange", resetClockSample);
    cleanups.push(() => {
      clearInterval(clockTimer);
      document.removeEventListener("visibilitychange", resetClockSample);
    });
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

  /**
   * The call's errors: a camera that would not open, a share that failed, a
   * DM that could not go out. They used to be a red line above the call,
   * pushing the whole stage down and seen only while the call was on
   * screen. The toast follows the slot exactly - shown while it holds a
   * message, gone when it is cleared (a retry, or its own timeout).
   */
  const slotError = $derived(transportState.error);
  $effect(() => {
    const message = slotError;
    const current = untrack(() => notices.find((n) => n.fromErrorSlot));
    if (current?.message === message) return;
    if (current) {
      untrack(() => {
        notices = notices.filter((n) => n.id !== current.id);
      });
    }
    if (message) untrack(() => push(message, { tone: "error", fromErrorSlot: true }));
  });

  /**
   * In a call with no microphone: denied, held by another app, not there.
   * Stays until a mic start succeeds - the transport withdraws the flag -
   * because a call you cannot speak in, untold, is the worst version.
   */
  const micUnavailable = $derived(transportState.inCall && transportState.micUnavailable);
  let micRetrying = $state(false);

  async function retryMic(): Promise<void> {
    micRetrying = true;
    try {
      // The join's own start path, with the remembered device (or the
      // system default when there is none).
      await setVoiceInputDevice(getVoiceActiveInputDevice() ?? "");
    } catch {
      // Still no microphone. The row stays, which is the honest answer.
    } finally {
      micRetrying = false;
    }
  }

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
    if (heldElsewhere) return "awful.chat is open in another tab.";
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
      class="pointer-events-auto flex w-full max-w-md items-start gap-2 rounded-lg border bg-background/95 px-3 py-2 text-xs shadow-lg backdrop-blur {notice.tone ===
      'error'
        ? 'border-destructive/50'
        : 'border-amber-500/40'}"
    >
      <CircleAlert
        class="mt-0.5 size-4 shrink-0 {notice.tone === 'error'
          ? 'text-destructive'
          : 'text-amber-500'}"
      />
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

  {#if micUnavailable}
    <div
      role="status"
      class="pointer-events-auto flex w-full max-w-md items-center justify-center gap-2 rounded-lg border border-amber-500/40 bg-background/95 px-3 py-1.5 text-xs shadow-lg backdrop-blur"
    >
      <MicOff class="size-3.5 shrink-0 text-amber-500" />
      <span class="text-foreground">Listen only, no microphone</span>
      <button
        type="button"
        onclick={retryMic}
        disabled={micRetrying}
        class="ml-1 rounded border border-border px-2 py-0.5 font-medium text-foreground hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
      >
        {micRetrying ? "Trying..." : "Retry"}
      </button>
    </div>
  {/if}

  {#if barText}
    <div
      role="status"
      class="pointer-events-auto flex w-full max-w-md items-center justify-center gap-2 rounded-lg border border-border bg-background/95 px-3 py-1.5 text-xs text-muted-foreground shadow-lg backdrop-blur"
    >
      {#if heldElsewhere}
        <AppWindow class="size-3.5 shrink-0 text-amber-500" />
      {:else if online}
        <ServerOff class="size-3.5 shrink-0 text-amber-500" />
      {:else}
        <WifiOff class="size-3.5 shrink-0 text-amber-500" />
      {/if}
      <span>{barText}</span>
      {#if heldElsewhere}
        <button
          type="button"
          onclick={claimNodeLock}
          class="ml-1 rounded border border-border px-2 py-0.5 font-medium text-foreground hover:bg-accent hover:text-accent-foreground"
        >
          Use here
        </button>
      {/if}
    </div>
  {/if}
</div>
