<script lang="ts">
  /**
   * The one-time ask for notification permission.
   *
   * Notifications are on by default in this app's own settings, but a browser
   * will only hand out the permission from a user gesture - so "default on"
   * has to mean "asked once, clearly, at a moment that makes sense". That
   * moment is the first unlock: there is now an identity that can receive
   * messages, and the user is looking at the app.
   *
   * On iOS a tab cannot show notifications at all; only an installed app can.
   * There the banner explains the two taps instead of asking for something
   * the browser has no way to grant.
   */
  import { Bell, X } from "@lucide/svelte";
  import { identityStore } from "$lib/identity/identity.svelte";
  import { notifyState, setNotificationsEnabled } from "$lib/notify.svelte";
  import { ensurePushSubscription, pushPrefs } from "$lib/push.svelte";
  import { isIos, isStandalone } from "$lib/install-prompt.svelte";

  const SNOOZE_KEY = "awful:notify-ask-snooze:v1";
  /** "Not now" is not "never", but it is a week. */
  const SNOOZE_MS = 7 * 24 * 60 * 60 * 1000;

  function snoozed(): boolean {
    try {
      const at = Number(localStorage.getItem(SNOOZE_KEY) ?? 0);
      return Number.isFinite(at) && Date.now() - at < SNOOZE_MS;
    } catch {
      return false;
    }
  }

  let dismissed = $state(snoozed());
  let asking = $state(false);

  // Phones only. A desktop keeps its tab open, so it gets notified without
  // push and the ask is noise there; the switch stays in Settings for anyone
  // who wants it. Coarse pointer, a narrow viewport or an installed app are
  // the three ways a phone looks like one.
  const phoneLike =
    typeof window !== "undefined" &&
    (window.matchMedia?.("(pointer: coarse)").matches ||
      window.innerWidth < 768 ||
      isStandalone());

  // A browser with no Notification at all and no home-screen install: iOS
  // Safari in a tab. Anywhere else that lacks it can do nothing about it, so
  // it is told nothing.
  const needsInstall = $derived(
    !notifyState.supported && isIos() && !isStandalone()
  );

  const show = $derived(
    phoneLike &&
      identityStore.isUnlocked &&
      !dismissed &&
      pushPrefs.enabled &&
      (needsInstall ||
        (notifyState.supported && notifyState.permission === "default"))
  );

  function notNow() {
    dismissed = true;
    try {
      localStorage.setItem(SNOOZE_KEY, String(Date.now()));
    } catch {
      // Storage blocked: it asks again next launch. Not worth failing for.
    }
  }

  async function turnOn() {
    asking = true;
    try {
      // Runs inside the click, which is the only place a browser will accept
      // a permission request.
      const granted = await setNotificationsEnabled(true);
      if (granted) await ensurePushSubscription();
      // Granted or denied, the question has been answered.
      dismissed = true;
    } finally {
      asking = false;
    }
  }
</script>

{#if show}
  <div
    class="fixed top-2 inset-x-2 z-50 mx-auto flex max-w-md items-center gap-3 rounded-lg border bg-background/95 px-3 py-2 font-mono text-xs shadow-lg backdrop-blur"
    role="status"
  >
    <Bell class="size-4 shrink-0 text-primary" />
    {#if needsInstall}
      <span class="min-w-0 flex-1 text-muted-foreground">
        Add to Home Screen first (Share, then Add to Home Screen) to get
        notifications on iOS.
      </span>
    {:else}
      <span class="min-w-0 flex-1 text-muted-foreground">
        Get told when a message arrives.
      </span>
      <button
        class="shrink-0 cursor-pointer rounded-md bg-primary px-2 py-1 text-xs font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-default disabled:opacity-70"
        onclick={turnOn}
        disabled={asking}
      >
        Turn on notifications
      </button>
    {/if}
    <button
      class="shrink-0 cursor-pointer text-muted-foreground hover:text-foreground"
      onclick={notNow}
      aria-label="Not now"
      title="Not now"
    >
      <X size={14} />
    </button>
  </div>
{/if}
