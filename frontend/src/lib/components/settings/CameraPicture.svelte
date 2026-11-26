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
    autoExposure,
    exposureByHand,
    hasAutoExposure,
    pictureChanged,
    pictureControls,
    resetPicture,
    setPicture,
    type PictureControl,
    type PictureKey,
  } from "$lib/camera-picture";

  let {
    track,
    live = true,
  }: {
    track: MediaStreamTrack;
    /** The camera is in the call now, not a preview before it. */
    live?: boolean;
  } = $props();

  let controls = $state<PictureControl[]>([]);
  let changed = $state(false);
  let byHand = $state(false);

  function read(t: MediaStreamTrack) {
    controls = pictureControls(t);
    changed = pictureChanged(t);
    byHand = exposureByHand(t);
  }

  $effect(() => {
    read(track);
  });

  // The slider also reports a value it only moved onto its own step grid,
  // when it is drawn and after Reset: a camera whose exposure step is a
  // third of a stop has 0 just off that grid. Only a value the person moved
  // it to is a change.
  let moving: PictureKey | null = null;

  function onChange(c: PictureControl, value: number) {
    if (moving !== c.key) return;
    changed = true;
    if (c.key === "exposureTime") byHand = true;
    void setPicture(track, c.key, value);
  }

  async function reset() {
    // What the slider reports after this is its own snapping, not a move.
    moving = null;
    await resetPicture(track);
    read(track);
  }

  async function auto() {
    moving = null;
    await autoExposure(track);
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
      <div
        class="flex flex-col gap-1.5"
        role="none"
        onpointerdown={() => (moving = c.key)}
        onkeydown={() => (moving = c.key)}
      >
        <div class="flex items-center justify-between gap-2">
          <Label class="text-xs font-mono text-muted-foreground">{c.label}</Label>
          <div class="flex items-center gap-2">
            {#if c.key === "exposureTime" && byHand && hasAutoExposure(track)}
              <button
                type="button"
                class="text-xs font-mono text-primary hover:underline"
                onclick={auto}>Auto</button
              >
            {/if}
            <span class="text-xs font-mono text-muted-foreground tabular-nums"
              >{shown(c)}</span
            >
          </div>
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
        {live
          ? "Everyone in the call sees these changes. They are kept for this camera."
          : "Kept for this camera, and used whenever it is on."}
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
