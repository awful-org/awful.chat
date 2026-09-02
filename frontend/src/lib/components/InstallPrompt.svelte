<script module lang="ts">
  // App.svelte mounts this above the route switch so the landing page offers
  // it too, and AppView still renders one of its own. Two dialogs asking the
  // same question at the same time is a bug, so the first instance wins and
  // any later one renders nothing.
  let claimed = false;
</script>

<script lang="ts">
  /// <reference path="../../vite-env.d.ts" />
  import { onMount } from "svelte";
  import { Download, Share } from "@lucide/svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";
  import {
    installSnoozed,
    installState,
    promptInstall,
    snoozeInstall,
  } from "$lib/install-prompt.svelte";

  const primary = !claimed;
  claimed = true;

  let open = $state(false);
  /** The share-sheet card, for a platform that has no install API at all. */
  let manual = $state(false);
  /** A moment after load, not the instant it fires: an offer that lands on
   *  top of the page the user is still reading is an ad, not a feature. */
  let waited = $state(false);
  /** Asked once per visit, whatever the answer was. */
  let answered = $state(false);

  onMount(() => {
    const timer = setTimeout(() => (waited = true), 3000);
    return () => clearTimeout(timer);
  });

  // An effect rather than a one-shot timer: beforeinstallprompt can arrive
  // after the delay above, and the iOS card is only DECIDED on a few seconds
  // in (it means "no prompt ever came"), so a single check at 3s saw neither.
  $effect(() => {
    if (!primary || !waited || answered) return;
    if (installState.standalone || installSnoozed()) return;
    if (installState.ready) {
      manual = false;
      open = true;
    } else if (installState.manual) {
      // Nothing to click on this platform, so the card explains the two taps.
      manual = true;
      open = true;
    }
  });

  async function handleInstall() {
    answered = true;
    await promptInstall();
    open = false;
  }

  function handleSkip() {
    answered = true;
    open = false;
    // Asked and answered: a month before it comes back.
    snoozeInstall();
  }
</script>

{#if primary && !installState.standalone}
  <Dialog.Root bind:open>
    <Dialog.Trigger />
    <Dialog.Content class="font-mono">
      <Dialog.Header>
        <div class="flex items-center gap-2 justify-center mb-2">
          {#if manual}
            <Share class="w-6 h-6 text-primary" />
          {:else}
            <Download class="w-6 h-6 text-primary" />
          {/if}
          <Dialog.Title>Install Awful.chat</Dialog.Title>
        </div>
        <Dialog.Description>
          {#if manual}
            Tap Share at the bottom of Safari, then "Add to Home Screen".
            Installed, the app can notify you about new messages; in a browser
            tab on iOS it cannot.
          {:else}
            Add Awful.chat to your home screen for quick access and a better
            experience!
          {/if}
        </Dialog.Description>
      </Dialog.Header>
      <div class="flex flex-col gap-2 mt-4">
        {#if !manual}
          <Button onclick={handleInstall}>Install app</Button>
        {/if}
        <Button variant="outline" onclick={handleSkip}>
          {manual ? "Got it" : "Maybe later"}
        </Button>
      </div>
    </Dialog.Content>
  </Dialog.Root>
{/if}
