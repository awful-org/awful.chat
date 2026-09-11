<script lang="ts">
  /**
   * The green room: see yourself and watch your own level before joining.
   *
   * Every other call app puts this in front of you, and /qc had nothing -
   * you picked a name and were in, with whatever camera and microphone the
   * browser felt like, and no way to find out beforehand that the wrong one
   * was selected or that the mic was dead.
   *
   * It runs its own preview stream rather than borrowing the call's, because
   * it exists BEFORE there is a call. That has a second use: getUserMedia is
   * what makes a browser hand over device labels, so opening this is also
   * what turns "Camera 1" into the camera's actual name.
   *
   * The stream is stopped on unmount and whenever the panel is closed. A
   * preview left running holds the camera light on behind a joined call.
   */
  import { onDestroy, untrack } from "svelte";
  import { Mic, Video, VideoOff } from "@lucide/svelte";
  import { Label } from "$lib/components/ui/label";
  import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
  } from "$lib/components/ui/select";
  import { cameraLabel, cameras, refreshCameras, watchCameras } from "$lib/cameras.svelte";
  import { loadAudioPrefs, saveAudioPrefs } from "$lib/transport/audio-prefs";

  let { open = false }: { open?: boolean } = $props();

  let video = $state<HTMLVideoElement | null>(null);
  // $state: the template reads it to show the "no picture" placeholder.
  let stream = $state<MediaStream | null>(null);
  let mics = $state<MediaDeviceInfo[]>([]);
  let mic = $state<string | null>(loadAudioPrefs().inputDevice);
  let camera = $state<string | null>(cameras.selected);
  /** 0..1, smoothed. Drives the bar that tells you the mic is alive. */
  let level = $state(0);
  let error = $state<string | null>(null);
  let audioCtx: AudioContext | null = null;
  let raf = 0;

  watchCameras();

  function teardown() {
    cancelAnimationFrame(raf);
    raf = 0;
    stream?.getTracks().forEach((t) => t.stop());
    stream = null;
    void audioCtx?.close().catch(() => {});
    audioCtx = null;
    level = 0;
  }

  onDestroy(teardown);

  /**
   * Attach the stream to the element, whichever arrives second.
   *
   * Assigning inside start() raced the element into existence: the panel is
   * behind an {#if}, so on the first open the <video> may not be bound yet,
   * and a single assignment that finds `video` null never happens again -
   * a black box with a live stream behind it. And `autoplay` is not enough
   * on its own for a srcObject set from script, so it is asked to play.
   */
  $effect(() => {
    if (!video || !stream) return;
    video.srcObject = stream;
    void video.play().catch(() => {});
  });

  /**
   * Open and close, and every device change, rebuild the preview.
   *
   * The body is untracked and the dependencies are read deliberately above
   * it, because the obvious version ate itself: teardown() READS `stream` and
   * start() WRITES it, so the effect depended on the very thing it set. Each
   * run stopped the stream the previous run had just acquired and asked for
   * another, forever - which is what a black preview and a level bar pinned
   * at zero actually were. The tracks were live for a moment and then
   * "ended", which is the tell.
   *
   * Teardown moves into the cleanup, where Svelte runs it before the next run
   * and once more on destroy - so there is exactly one place that stops a
   * stream, and it cannot race the place that starts one.
   */
  $effect(() => {
    const wantOpen = open;
    const wantCamera = camera;
    const wantMic = mic;
    untrack(() => {
      if (wantOpen) void start(wantCamera, wantMic);
    });
    return () => untrack(teardown);
  });

  async function start(cameraId: string | null, micId: string | null) {
    error = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: cameraId ? { deviceId: { ideal: cameraId } } : true,
        audio: micId ? { deviceId: { ideal: micId } } : true,
      });
    } catch (err) {
      // A refused permission or a camera another app is holding. The mic and
      // camera pickers are still worth showing; joining is still allowed.
      error =
        err instanceof Error && err.name === "NotAllowedError"
          ? "Your browser is not letting this page use the camera or microphone."
          : "Could not open the camera or microphone.";
      return;
    }
    // Labels arrive with permission, so this is the moment the lists become
    // readable rather than a row of "Camera 1".
    void refreshCameras();
    void navigator.mediaDevices
      .enumerateDevices()
      .then((all) => (mics = all.filter((d) => d.kind === "audioinput")))
      .catch(() => {});
    meter();
  }

  /** A plain RMS meter. Enough to answer "is it hearing me". */
  function meter() {
    const track = stream?.getAudioTracks()[0];
    if (!track) return;
    audioCtx = new AudioContext();
    // A context created off the back of an awaited getUserMedia is not
    // covered by the click that started it, so it begins suspended and every
    // analyser read comes back as silence - a level bar that never moves.
    // The call's own detector resumes for the same reason (speakers.svelte).
    void audioCtx.resume().catch(() => {});
    const analyser = audioCtx.createAnalyser();
    analyser.fftSize = 512;
    audioCtx.createMediaStreamSource(new MediaStream([track])).connect(analyser);
    const bins = new Float32Array(analyser.fftSize);
    const tick = () => {
      analyser.getFloatTimeDomainData(bins);
      let sum = 0;
      for (const v of bins) sum += v * v;
      const rms = Math.sqrt(sum / bins.length);
      // Decay slowly, rise fast: a bar that tracks the raw value exactly
      // reads as noise rather than as speech.
      level = Math.max(Math.min(rms * 4, 1), level * 0.88);
      raf = requestAnimationFrame(tick);
    };
    tick();
  }

  function pickCamera(id: string) {
    camera = id || null;
    saveAudioPrefs({ cameraDevice: camera });
    cameras.selected = camera;
  }

  function pickMic(id: string) {
    mic = id || null;
    saveAudioPrefs({ inputDevice: mic });
  }
</script>

{#if open}
  <div class="flex w-full flex-col gap-3">
    <div
      class="relative aspect-video w-full overflow-hidden rounded-lg border border-border bg-muted/40"
    >
      <!-- muted: this is your own microphone coming back at you. -->
      <!-- svelte-ignore a11y_media_has_caption -->
      <video
        bind:this={video}
        autoplay
        playsinline
        muted
        class="size-full scale-x-[-1] object-cover"
      ></video>
      {#if !stream}
        <div
          class="absolute inset-0 flex items-center justify-center text-muted-foreground"
        >
          <VideoOff class="size-6" />
        </div>
      {/if}
    </div>

    {#if error}
      <p class="text-xs text-destructive font-mono leading-relaxed">{error}</p>
    {/if}

    <div class="flex items-center gap-2">
      <Mic class="size-3.5 shrink-0 text-muted-foreground" />
      <div class="h-1.5 flex-1 overflow-hidden rounded bg-muted">
        <div
          class="h-full bg-green-500 transition-[width] duration-75"
          style="width: {Math.round(level * 100)}%"
        ></div>
      </div>
    </div>

    <div class="flex flex-col gap-1.5">
      <Label
        class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
      >
        <Video class="mr-1 inline size-3" /> Camera
      </Label>
      <Select type="single" value={camera ?? ""} onValueChange={pickCamera}>
        <SelectTrigger class="bg-background border-input font-mono text-sm">
          <span class="block truncate">
            {cameras.devices.find((d) => d.deviceId === camera)?.label ||
              "System default"}
          </span>
        </SelectTrigger>
        <SelectContent class="bg-popover border-border font-mono">
          {#each cameras.devices as dev, i (dev.deviceId)}
            <SelectItem value={dev.deviceId} class="font-mono text-sm">
              <span class="block truncate">{cameraLabel(dev, i)}</span>
            </SelectItem>
          {/each}
        </SelectContent>
      </Select>
    </div>

    <div class="flex flex-col gap-1.5">
      <Label
        class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
      >
        <Mic class="mr-1 inline size-3" /> Microphone
      </Label>
      <Select type="single" value={mic ?? ""} onValueChange={pickMic}>
        <SelectTrigger class="bg-background border-input font-mono text-sm">
          <span class="block truncate">
            {mics.find((d) => d.deviceId === mic)?.label || "System default"}
          </span>
        </SelectTrigger>
        <SelectContent class="bg-popover border-border font-mono">
          {#each mics as dev, i (dev.deviceId)}
            <SelectItem value={dev.deviceId} class="font-mono text-sm">
              <span class="block truncate"
                >{dev.label || `Microphone ${i + 1}`}</span
              >
            </SelectItem>
          {/each}
        </SelectContent>
      </Select>
    </div>
  </div>
{/if}
