<script lang="ts">
  /**
   * The picture controls while the camera is off: a preview of the chosen
   * camera to adjust against, like the mic test. What is set here is saved
   * for that camera, and the call's camera starts with it.
   *
   * The preview stops with its button, when the chosen camera changes (it
   * restarts on the new one), and when this is unmounted: closing Settings,
   * or the call's camera coming on, whose own track the section then shows.
   */
  import { onDestroy, untrack } from "svelte";
  import { Button } from "$lib/components/ui/button";
  import { cameras } from "$lib/cameras.svelte";
  import { restorePicture } from "$lib/camera-picture";
  import { cameraCaptureConstraints, isHandheld, openCamera } from "$lib/transport/camera-quality";
  import CameraPicture from "./CameraPicture.svelte";

  let stream = $state<MediaStream | null>(null);
  let starting = $state(false);
  let error = $state<string | null>(null);
  let video = $state<HTMLVideoElement | null>(null);
  let request = 0;
  let destroyed = false;

  const track = $derived(stream?.getVideoTracks()[0] ?? null);

  function stop() {
    request++;
    starting = false;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
  }

  async function start(deviceId: string | null) {
    stop();
    const mine = ++request;
    starting = true;
    error = null;
    try {
      // The size the call asks for (see DeviceCheck): a preview opened at
      // the default 640x480 holds the camera there for a call camera started
      // while it runs. And the chosen camera exactly, as the call opens it.
      const acquired = await openCamera(deviceId, cameraCaptureConstraints(isHandheld()));
      const first = acquired.getVideoTracks()[0];
      if (first) await restorePicture(first);
      if (mine !== request || destroyed) {
        acquired.getTracks().forEach((t) => t.stop());
        return;
      }
      stream = acquired;
    } catch (err) {
      if (mine !== request) return;
      error =
        err instanceof Error && err.name === "NotAllowedError"
          ? "Your browser is not letting this page use the camera."
          : "Could not open the camera. Check whether another app is using it.";
    } finally {
      if (mine === request) starting = false;
    }
  }

  // A different camera chosen while previewing: preview that one.
  let previewed: string | null = null;
  $effect(() => {
    const wanted = cameras.selected;
    const previewing = stream !== null;
    untrack(() => {
      if (previewing && wanted !== previewed) {
        previewed = wanted;
        void start(wanted);
      }
    });
  });

  function toggle() {
    if (stream || starting) stop();
    else {
      previewed = cameras.selected;
      void start(previewed);
    }
  }

  $effect(() => {
    if (!video || !stream) return;
    video.srcObject = stream;
    void video.play().catch(() => {});
  });

  onDestroy(() => {
    destroyed = true;
    stop();
  });
</script>

<Button
  variant={stream ? "destructive" : "outline"}
  size="sm"
  class="w-full font-mono text-xs"
  onclick={toggle}
>
  {stream ? "■ Stop preview" : starting ? "Opening camera…" : "▶ Preview camera"}
</Button>

{#if error}
  <p role="status" class="text-xs text-destructive font-mono">{error}</p>
{/if}

{#if stream && track}
  <!-- Side by side where there is room, so the sliders sit next to the
       picture they change rather than under the fold. -->
  <div class="grid gap-4 sm:grid-cols-2 sm:items-start">
    <!-- svelte-ignore a11y_media_has_caption -->
    <video
      bind:this={video}
      autoplay
      playsinline
      muted
      class="aspect-video w-full rounded-lg border border-border bg-muted/40 object-cover scale-x-[-1]"
    ></video>
    {#key track}
      <CameraPicture {track} live={false} />
    {/key}
  </div>
{:else if !starting && !error}
  <p class="text-xs text-muted-foreground font-mono">
    Your camera is off. Preview it to adjust its picture, and the call uses
    what you set here.
  </p>
{/if}
