<script lang="ts">
  /**
   * Sliders for the camera's own picture controls (camera-picture.ts), for
   * the camera that is on now. Only what this camera and browser offer is
   * shown, and a change is seen by everyone at once: it is the camera's own
   * setting, not a filter.
   */
  import { Label } from "$lib/components/ui/label";
  import { Slider } from "$lib/components/ui/slider";
  import { Button } from "$lib/components/ui/button";
  import {
    pictureChanged,
    pictureControls,
    resetPicture,
    setPicture,
    type PictureControl,
  } from "$lib/camera-picture";

  let { track }: { track: MediaStreamTrack } = $props();

  let controls = $state<PictureControl[]>([]);
  let changed = $state(false);

  function read(t: MediaStreamTrack) {
    controls = pictureControls(t);
    changed = pictureChanged(t);
  }

  $effect(() => {
    read(track);
  });

  function onChange(c: PictureControl, value: number) {
    changed = true;
    void setPicture(track, c.key, value);
  }

  async function reset() {
    await resetPicture(track);
    read(track);
  }

  function shown(c: PictureControl): string {
    const span = c.max - c.min;
    return `${Math.round(((c.value - c.min) / span) * 100)}%`;
  }
</script>

{#if controls.length > 0}
  <div class="flex flex-col gap-3" role="group" aria-label="Camera picture">
    {#each controls as c (c.key)}
      <div class="flex flex-col gap-1.5">
        <div class="flex items-center justify-between">
          <Label class="text-xs font-mono text-muted-foreground">{c.label}</Label>
          <span class="text-xs font-mono text-muted-foreground tabular-nums">{shown(c)}</span>
        </div>
        <Slider
          aria-label={c.label}
          type="single"
          bind:value={c.value}
          min={c.min}
          max={c.max}
          step={c.step}
          onValueChange={(v: number) => onChange(c, v)}
          class="w-full"
        />
      </div>
    {/each}
    <div class="flex items-center justify-between gap-3">
      <p class="text-xs text-muted-foreground font-mono">
        Everyone in the call sees these changes. They are kept for this camera.
      </p>
      <Button
        variant="outline"
        size="sm"
        class="font-mono shrink-0"
        disabled={!changed}
        onclick={reset}>Reset</Button
      >
    </div>
  </div>
{:else}
  <p class="text-xs text-muted-foreground font-mono">
    This camera or browser offers no picture settings.
  </p>
{/if}
