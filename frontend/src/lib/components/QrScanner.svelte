<script lang="ts">
  /**
   * A camera viewfinder that reads QR codes (lib/qr-scanner.svelte.ts).
   * Starts on mount with the back camera, stops on unmount. What a code
   * means is the caller's: onText says whether it was the one wanted.
   */
  import { onDestroy, onMount } from "svelte";
  import { Camera, Flashlight, FlashlightOff, SwitchCamera } from "@lucide/svelte";
  import {
    cameraFacing,
    otherSideCameraId,
    scannerState,
    startQrScan,
    stopQrScan,
    toggleScanTorch,
  } from "$lib/qr-scanner.svelte";

  let {
    onText,
    onUnavailable,
  }: {
    /** Every decoded string; true when it was the code wanted, which stops the scan. */
    onText: (text: string) => boolean;
    /** No camera to run: refused, missing or busy. */
    onUnavailable?: (message: string) => void;
  } = $props();

  const elementId = `qr-scanner-${crypto.randomUUID().slice(0, 8)}`;
  let alive = true;
  let starting: Promise<void> | null = null;

  async function start(cameraId?: string): Promise<void> {
    const run = startQrScan(elementId, (text) => alive && onText(text), cameraId);
    starting = run;
    try {
      await run;
    } catch (err) {
      if (alive) onUnavailable?.(err instanceof Error ? err.message : String(err));
    } finally {
      if (starting === run) starting = null;
    }
    // Closed while the camera was still starting: release it now.
    if (!alive) await stopQrScan(elementId);
  }

  onMount(() => void start());
  onDestroy(() => {
    alive = false;
    if (!starting) void stopQrScan(elementId);
  });

  const other = $derived(otherSideCameraId(scannerState.cameras, scannerState.activeCameraId));
  const onFront = $derived(
    cameraFacing(scannerState.cameras.find((c) => c.id === scannerState.activeCameraId)) === "front"
  );
</script>

<div class="relative w-full">
  <div id={elementId} class="w-full aspect-square bg-black rounded-lg overflow-hidden"></div>
  <!-- Over the viewfinder, because that is where the user is looking while
       they hold a phone up to a code. -->
  <div class="absolute right-2 top-2 flex flex-col gap-2">
    {#if other}
      <button
        type="button"
        onclick={() => void start(other)}
        aria-label={onFront ? "Use the back camera" : "Use the front camera"}
        title={onFront ? "Use the back camera" : "Use the front camera"}
        class="inline-flex size-11 items-center justify-center rounded-lg bg-black/60 text-white backdrop-blur hover:bg-black/80 cursor-pointer"
      >
        <SwitchCamera class="size-5" />
      </button>
    {/if}
    {#if scannerState.torchAvailable}
      <button
        type="button"
        onclick={() => void toggleScanTorch()}
        aria-pressed={scannerState.torchOn}
        aria-label={scannerState.torchOn ? "Turn off torch" : "Turn on torch"}
        class="inline-flex size-11 items-center justify-center rounded-lg backdrop-blur cursor-pointer {scannerState.torchOn
          ? 'bg-white text-black'
          : 'bg-black/60 text-white hover:bg-black/80'}"
      >
        {#if scannerState.torchOn}
          <Flashlight class="size-5" />
        {:else}
          <FlashlightOff class="size-5" />
        {/if}
      </button>
    {/if}
  </div>
  {#if scannerState.awaitingPermission}
    <!-- The prompt is open and unanswered. Without this the view was a black
         square for however long the user took to read it, which reads as a
         scanner that does not work. -->
    <div
      class="absolute inset-0 flex flex-col items-center justify-center gap-2 rounded-lg bg-black/80 p-4 text-center"
    >
      <Camera class="size-8 text-white/80" />
      <p class="text-xs text-white/80">
        Waiting for camera permission - answer your browser's prompt to start
        scanning.
      </p>
    </div>
  {/if}
</div>
