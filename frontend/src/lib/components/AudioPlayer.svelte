<script lang="ts">
  /**
   * Compact player for audio attachments. The native <audio controls> bar
   * ignores the app's theme and looks different in every browser, so this
   * drives a headless <audio> element instead and keeps the same mono styling
   * as the rest of a message.
   */
  import { Pause, Play, Volume2, VolumeX } from "@lucide/svelte";

  interface Props {
    src: string;
    /** Announced to screen readers; the filename is already shown above. */
    label?: string;
    class?: string;
  }

  let { src, label = "audio attachment", class: className = "" }: Props =
    $props();

  // One volume for every audio attachment, remembered on this device - a
  // per-clip volume would reset to full blast on the next voice note.
  const VOLUME_KEY = "awful:audio-attachment-volume:v1";
  function loadVolume(): number {
    try {
      const v = Number(localStorage.getItem(VOLUME_KEY));
      return Number.isFinite(v) && v >= 0 && v <= 1 ? v : 1;
    } catch {
      return 1;
    }
  }

  let el = $state<HTMLAudioElement | null>(null);
  let playing = $state(false);
  let muted = $state(false);
  const initialVolume = loadVolume();
  let volume = $state(initialVolume);
  /** The level to come back to when unmuting from zero. */
  let lastAudible = initialVolume > 0 ? initialVolume : 1;
  $effect(() => {
    if (!el) return;
    el.volume = volume;
    el.muted = muted;
  });

  // Mute and the slider are one control: the slider reads 0 while muted,
  // moving it up unmutes, and dragging it to 0 is muting. They used to be
  // separate, so a muted clip stayed silent however far the slider moved.
  function setVolume(value: number) {
    volume = value;
    if (value > 0) {
      lastAudible = value;
      muted = false;
    }
    try {
      localStorage.setItem(VOLUME_KEY, String(value));
    } catch {
      // Storage blocked: the level just does not survive a reload.
    }
  }

  function toggleMute(): void {
    if (muted || volume === 0) {
      muted = false;
      if (volume === 0) setVolume(lastAudible);
    } else {
      muted = true;
    }
  }
  let currentTime = $state(0);
  let duration = $state(0);
  /** While dragging, the slider owns the position, not the timeupdate events. */
  let scrubbing = $state(false);

  function fmt(seconds: number): string {
    if (!Number.isFinite(seconds) || seconds < 0) return "--:--";
    const total = Math.floor(seconds);
    const m = Math.floor(total / 60);
    const s = total % 60;
    return `${m}:${String(s).padStart(2, "0")}`;
  }

  function toggle() {
    if (!el) return;
    if (el.paused) el.play().catch(() => {});
    else el.pause();
  }

  function onMeta() {
    // Streamed blobs can report Infinity until enough is buffered.
    duration = el && Number.isFinite(el.duration) ? el.duration : 0;
  }

  function onTime() {
    if (!el || scrubbing) return;
    currentTime = el.currentTime;
    if (!duration && Number.isFinite(el.duration)) duration = el.duration;
  }

  function seekTo(value: number) {
    currentTime = value;
    if (el) el.currentTime = value;
  }

  const progress = $derived(
    duration > 0 ? Math.min(100, (currentTime / duration) * 100) : 0
  );
</script>

<div
  class="flex items-center gap-2 rounded-md border border-border/70 bg-background/60 px-2 py-1.5 {className}"
>
  <!-- svelte-ignore a11y_media_has_caption -->
  <audio
    bind:this={el}
    {src}
    preload="metadata"
    onloadedmetadata={onMeta}
    ondurationchange={onMeta}
    ontimeupdate={onTime}
    onplay={() => (playing = true)}
    onpause={() => (playing = false)}
    onended={() => {
      playing = false;
      currentTime = 0;
    }}
  ></audio>

  <button
    type="button"
    onclick={toggle}
    aria-label={playing ? `Pause ${label}` : `Play ${label}`}
    class="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-full bg-primary text-primary-foreground hover:bg-primary/90"
  >
    {#if playing}
      <Pause class="size-3.5" />
    {:else}
      <Play class="size-3.5 translate-x-px" />
    {/if}
  </button>

  <input
    type="range"
    min="0"
    max={duration || 0}
    step="0.01"
    value={currentTime}
    disabled={!duration}
    aria-label={`Seek ${label}`}
    oninput={(e) => seekTo(Number(e.currentTarget.value))}
    onpointerdown={() => (scrubbing = true)}
    onpointerup={() => (scrubbing = false)}
    onkeydown={() => (scrubbing = true)}
    onkeyup={() => (scrubbing = false)}
    class="h-1 min-w-16 flex-1 cursor-pointer appearance-none rounded-full bg-muted accent-primary disabled:cursor-default"
    style={`background: linear-gradient(to right, var(--primary) ${progress}%, var(--muted) ${progress}%)`}
  />

  <span class="shrink-0 font-mono text-[10px] tabular-nums text-muted-foreground">
    {fmt(currentTime)} / {fmt(duration)}
  </span>

  <!-- Hovering (or focusing) the mute button reveals the level; the click
       still mutes. focus-within keeps the popover up while dragging. -->
  <div class="group/vol relative shrink-0">
    <button
      type="button"
      onclick={toggleMute}
      aria-label={muted || volume === 0 ? `Unmute ${label}` : `Mute ${label}`}
      class="inline-flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground hover:text-foreground"
    >
      {#if muted || volume === 0}
        <VolumeX class="size-3.5" />
      {:else}
        <Volume2 class="size-3.5" />
      {/if}
    </button>
    <div
      class="pointer-events-none absolute bottom-full right-0 z-20 pb-1.5 opacity-0 transition-opacity group-hover/vol:pointer-events-auto group-hover/vol:opacity-100 group-focus-within/vol:pointer-events-auto group-focus-within/vol:opacity-100"
    >
      <div
        class="rounded-md border border-border bg-popover px-2 py-1.5 shadow-md"
      >
        <input
          type="range"
          min="0"
          max="1"
          step="0.05"
          value={muted ? 0 : volume}
          aria-label={`Volume for ${label}`}
          oninput={(e) => setVolume(Number(e.currentTarget.value))}
          class="h-1 w-20 cursor-pointer accent-primary"
        />
      </div>
    </div>
  </div>
</div>
