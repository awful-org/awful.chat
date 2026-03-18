<script lang="ts">
  /// <reference path="../../vite-env.d.ts" />
  import { onMount } from "svelte";
  import { Download } from "@lucide/svelte";
  import * as Dialog from "$lib/components/ui/dialog/index.js";
  import { Button } from "$lib/components/ui/button/index.js";

  let open = $state(false);
  let deferredPrompt = $state<BeforeInstallPromptEvent | null>(null);
  let isStandalone = $state(false);

  onMount(() => {
    // Check if already installed
    isStandalone = window.matchMedia("(display-mode: standalone)").matches || 
                   (window.navigator as any).standalone === true;

    if (isStandalone) return;

    const handler = (e: BeforeInstallPromptEvent) => {
      e.preventDefault();
      deferredPrompt = e;
      // Auto-show after a delay (optional, or wait for user action)
      // Let's show it automatically for now, but maybe with a cooldown
      setTimeout(() => {
        if (deferredPrompt && !isStandalone) {
          open = true;
        }
      }, 3000); // Show 3 seconds after load
    };

    window.addEventListener("beforeinstallprompt", handler as any);

    return () => {
      window.removeEventListener("beforeinstallprompt", handler as any);
    };
  });

  async function handleInstall() {
    if (!deferredPrompt) return;

    deferredPrompt.prompt();
    const { outcome } = await deferredPrompt.userChoice;

    if (outcome === "accepted") {
      console.log("User accepted the install prompt");
      // Once installed, the app will likely restart or open as standalone
      // We can close the dialog immediately
      open = false;
    } else {
      console.log("User dismissed the install prompt");
    }

    deferredPrompt = null;
  }

  function handleSkip() {
    open = false;
    // We could store a preference here to not show again
  }
</script>

{#if !isStandalone}
  <Dialog.Root bind:open>
    <Dialog.Trigger />
    <Dialog.Content>
      <Dialog.Header>
        <div class="flex items-center gap-2 justify-center mb-2">
          <Download class="w-6 h-6 text-primary" />
          <Dialog.Title>Install Awful.chat</Dialog.Title>
        </div>
        <Dialog.Description>
          Add Awful.chat to your home screen for quick access and a better experience!
        </Dialog.Description>
      </Dialog.Header>
      <div class="flex flex-col gap-2 mt-4">
        <Button onclick={handleInstall}>Install App</Button>
        <Button variant="outline" onclick={handleSkip}>Maybe Later</Button>
      </div>
    </Dialog.Content>
  </Dialog.Root>
{/if}
