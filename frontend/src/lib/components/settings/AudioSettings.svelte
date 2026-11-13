<script lang="ts">
  import { onDestroy } from "svelte";
  import { Label } from "$lib/components/ui/label";
  import { Slider } from "$lib/components/ui/slider";
  import { Switch } from "$lib/components/ui/switch";
  import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
  } from "$lib/components/ui/select";
  import { Button } from "$lib/components/ui/button";
  import { Tip } from "$lib/components/ui/tooltip";
  import { ChevronRight, Info, Loader2 } from "@lucide/svelte";
  import { transportState, _dtln, _dfn } from "$lib/transport/transport.svelte";
  import type { MicDenoiser } from "$lib/audio/dtln-processor";
  import {
    AUDIO_PREF_DEFAULTS,
    DFN_PAUSE_DB,
    DFN_SPEECH_DB,
    NOISE_ENGINE_LABELS,
    clampDfnAttenuation,
    type NoiseEngine,
  } from "$lib/transport/audio-prefs";
  import { pickMicTestEngine } from "./mic-test-engine";
  import {
    cameraLabel,
    cameras,
    setCamera,
    watchCameras,
  } from "$lib/cameras.svelte";
  import {
    getVoiceActiveInputDevice,
    getVoiceActiveOutputDevice,
    getVoiceInputDevices,
    getVoiceOutputDevices,
    setVoiceInputDevice,
    setVoiceOutputDevice,
    getVoiceInputGain,
    setVoiceInputGain,
    getVoiceOutputVolume,
    setVoiceOutputVolume,
    getVoiceDtlnEnabled,
    voiceProcessing,
    setVoiceDtlnEnabled,
    setVoiceDtlnNoiseGate,
    getVoiceDtlnNoiseGate,
    getVoiceNoiseEngine,
    setVoiceNoiseEngine,
    getVoiceDfnAttenuation,
    setVoiceDfnAttenuation,
  } from "$lib/transport/voice.svelte";
  import {
    setDeafened,
    toggleMute,
    getShareAudioDespiteEchoRisk,
    setShareAudioDespiteEchoRisk,
  } from "$lib/transport/call.svelte";
  import {
    formatGain,
    gainToSlider,
    sliderToGain,
  } from "$lib/audio/volume-curve";

  // Mirrors the call path in libp2p/voice.ts (the mic test must preview what
  // peers actually get): AEC on even with DTLN - DTLN does noise, not echo.
  const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: false,
    // Mirrors the call path: AGC keeps a quiet mic clear of DTLN's gate.
    autoGainControl: true,
  };

  const AUDIO_CONSTRAINTS_NO_DTLN: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    // Mirrors the call path: AGC levels the mic there, so the test must too.
    autoGainControl: true,
  };

  let inputDevices = $state<MediaDeviceInfo[]>([]);
  let outputDevices = $state<MediaDeviceInfo[]>([]);
  // Device enumeration is async: swapping the fallback line for the taller
  // Select once it lands shifted the whole tab. A select-sized skeleton
  // holds the height until we know which one renders.
  let devicesLoaded = $state(false);
  let activeInput = $state<string | null>(null);
  let activeOutput = $state<string | null>(null);

  // The settings. What actually runs is voiceProcessing.engine: a model that
  // fails falls back for the call without touching either.
  let dtlnEnabled = $state(getVoiceDtlnEnabled());
  let noiseEngine = $state(getVoiceNoiseEngine());
  const DENOISERS: Record<NoiseEngine, MicDenoiser> = { dfn3: _dfn, dtln: _dtln };
  // Restored from the last session, not a fresh default.
  let noiseGateThreshold = $state(getVoiceDtlnNoiseGate());
  let noiseGateSlider = $state<number[]>([getVoiceDtlnNoiseGate() * 10000]);
  // DeepFilterNet3's strength. Applied on release: new values rebuild its
  // node, which a call and a mic test then move onto.
  let dfnSpeechDb = $state(getVoiceDfnAttenuation().speechDb);
  let dfnPauseDb = $state(getVoiceDfnAttenuation().pauseDb);
  const DFN_DEFAULT_SPEECH_DB = AUDIO_PREF_DEFAULTS.dfnSpeechAttenuationDb;
  const DFN_DEFAULT_PAUSE_DB = AUDIO_PREF_DEFAULTS.dfnPauseAttenuationDb;
  let applyingDfn = $state(false);
  /** Set while a DeepFilterNet3 mic test runs: moves it onto a rebuilt node. */
  let rebuildMicTest: (() => Promise<void>) | null = null;
  /** While dragging: pauses stay above speech, so the sliders show what will run. */
  function clampDfnSliders() {
    ({ speechDb: dfnSpeechDb, pauseDb: dfnPauseDb } = clampDfnAttenuation(dfnSpeechDb, dfnPauseDb));
  }
  async function applyDfnStrength() {
    applyingDfn = true;
    try {
      let rebuilt = true;
      try {
        ({ rebuilt } = await setVoiceDfnAttenuation(dfnSpeechDb, dfnPauseDb));
      } catch (e) {
        // The node was retired before the call's mic failed to come back.
        console.error("[audio] the call's mic did not restart:", e);
      }
      if (rebuilt && rebuildMicTest) {
        try {
          await rebuildMicTest();
        } catch (e) {
          // As a test that fails to start: it ends, nothing half-built stays.
          console.error("[audio] mic test could not restart:", e);
          if (isMicTesting) await handleMicTest();
        }
      }
    } finally {
      applyingDfn = false;
    }
  }
  function resetDfnStrength() {
    dfnSpeechDb = DFN_DEFAULT_SPEECH_DB;
    dfnPauseDb = DFN_DEFAULT_PAUSE_DB;
    void applyDfnStrength();
  }
  // A switch or engine change during a call rebuilds the mic, which can wait
  // on a model download: the header says so until it is done.
  let rearming = $state(0);
  async function rearm(change: Promise<void>) {
    rearming++;
    try {
      await change;
    } finally {
      rearming--;
    }
  }
  // Off by default: screen-share audio that could not be confirmed
  // echo-free is withheld unless the sharer opts in here (share-audio.ts).
  let shareAudioDespiteEchoRisk = $state(getShareAudioDespiteEchoRisk());

  let isMicTesting = $state(false);
  // Distinct from isMicTesting: set only during async startup so a second
  // click can't stop-then-orphan a test that hasn't finished starting.
  let isMicStarting = $state(false);
  // DeepFilterNet3's strength is held while anything rebuilds or loads the
  // mic chain: a node still loading keeps the values it started with.
  const dfnBusy = $derived(
    applyingDfn || rearming > 0 || voiceProcessing.loading || isMicStarting
  );
  // Closing the dialog mid-start (a cold DFN3 download takes up to 15 s) must
  // not let the test come up afterwards with nothing left to stop it: the
  // start path checks this after every await and bails through its catch.
  let destroyed = false;
  function bailIfDestroyed() {
    if (destroyed) throw new Error("settings closed while the mic test was starting");
  }
  // The starting test's context, for onDestroy to close without waiting on a
  // start that may never settle (an unanswered permission prompt).
  let testCtx: AudioContext | null = null;
  let micTestDisconnect: (() => void) | null = null;
  let micLevel = $state(0);
  let micLevelInterval: ReturnType<typeof setInterval> | null = null;
  let micLevelAnalyser: AnalyserNode | null = null;
  let micTestAudio: HTMLAudioElement | null = null;
  // What the test actually plays through, which a fallback can make differ
  // from what a call uses; shown instead of it while the test runs.
  let micTestEngine = $state<NoiseEngine | "browser">("browser");
  let micTestNotice = $state<string | null>(null);
  const shownEngine = $derived(isMicTesting ? micTestEngine : voiceProcessing.engine);

  // Shared with the per-person volume menu. The old curve here had no exact
  // position for 100%, so a restored setting came back reading 102% and the
  // number crept every time the page was reloaded.
  const gainToPercent = formatGain;

  // Initialise from the LIVE values, not a hardcoded 100%: mounting at the
  // default and snapping to the saved value a beat later is the "slider
  // flickers when I come back" report - and if the slider component emits a
  // change during that window, the default gets SAVED over the user's value.
  function liveInputSlider(): number {
    try {
      return gainToSlider(getVoiceInputGain());
    } catch {
      return gainToSlider(1.0);
    }
  }
  function liveOutputSlider(): number {
    try {
      return gainToSlider(getVoiceOutputVolume());
    } catch {
      return gainToSlider(1.0);
    }
  }
  let inputSlider = $state<number[]>([liveInputSlider()]);
  let outputSlider = $state<number[]>([liveOutputSlider()]);

  // The list is live: a phone offering itself as a camera attaches and
  // detaches while this dialog is open.
  watchCameras();

  $effect(() => {
    activeInput = getVoiceActiveInputDevice();
    activeOutput = getVoiceActiveOutputDevice();
    inputSlider = [liveInputSlider()];
    outputSlider = [liveOutputSlider()];
    void Promise.allSettled([
      getVoiceInputDevices().then((d) => {
        inputDevices = d;
      }),
      getVoiceOutputDevices().then((d) => {
        outputDevices = d;
      }),
    ]).then(() => {
      devicesLoaded = true;
    });
  });

  function handleInputGainChange(vals: number[]) {
    inputSlider = vals;
    const gain = sliderToGain(vals[0]);
    // No-op guard: a change event that does not change the value is the
    // component syncing, not the user - acting on it can save a stale value
    // and flip the mute state on mount.
    try {
      if (Math.abs(gain - getVoiceInputGain()) < 1e-6) return;
    } catch {}
    setVoiceInputGain(gain);
    if (gain <= 0 && !transportState.muted) toggleMute();
    else if (gain > 0 && transportState.muted) toggleMute();
  }

  function handleOutputVolumeChange(vals: number[]) {
    outputSlider = vals;
    const volume = sliderToGain(vals[0]);
    try {
      if (Math.abs(volume - getVoiceOutputVolume()) < 1e-6) return;
    } catch {}
    setVoiceOutputVolume(volume);
  }

  async function handleInputDeviceChange(deviceId: string) {
    activeInput = deviceId || null;
    await setVoiceInputDevice(deviceId);
  }

  async function handleOutputDeviceChange(deviceId: string) {
    activeOutput = deviceId || null;
    await setVoiceOutputDevice(deviceId);
  }

  async function handleNoiseEngineChange(engine: NoiseEngine) {
    noiseEngine = engine;
    await rearm(setVoiceNoiseEngine(engine));
  }

  async function handleMicTest() {
    if (isMicTesting) {
      micTestDisconnect?.();
      micTestDisconnect = null;
      if (micLevelInterval) clearInterval(micLevelInterval);
      micLevelInterval = null;
      micLevelAnalyser?.disconnect();
      micLevelAnalyser = null;
      micLevel = 0;
      // Undeafen when stopping test
      setDeafened(false);
      isMicTesting = false;
      return;
    }

    // A click while the test is still starting up is ignored - it must not
    // fall through and start a second getUserMedia (leaking the first).
    if (isMicStarting) return;
    isMicStarting = true;

    // Kept outside the try so the catch can clean up a half-built test:
    // the mic capture and the monitor graph exist before micTestDisconnect is
    // assigned, and a lingering monitor blocks the transport edge of every
    // future mic rebuild.
    let testStream: MediaStream | null = null;
    let dtlnCleanup: (() => void) | null = null;
    let denoiser: MicDenoiser | null = null;
    testCtx = null;

    try {
      // Deafen when starting test (mutes both input and output)
      setDeafened(true);

      // Plays the test. A default context, as a call's is, so its rate is
      // the hardware's: what decides whether DeepFilterNet3 can run.
      const ctx = (testCtx = new AudioContext());
      // The model in use right now, or the one a call would fall back to,
      // so the test plays what peers get.
      const picked = await pickMicTestEngine(voiceProcessing.engine, ctx.sampleRate, DENOISERS);
      bailIfDestroyed();
      const model = (denoiser = picked.engine ? DENOISERS[picked.engine] : null);
      micTestEngine = picked.engine ?? "browser";
      micTestNotice = picked.notice;

      // A model handles noise suppression, so we disable native ones if one runs
      const constraints: MediaStreamConstraints = {
        audio: activeInput
          ? {
              ...(model ? AUDIO_CONSTRAINTS : AUDIO_CONSTRAINTS_NO_DTLN),
              deviceId: { exact: activeInput },
            }
          : model
            ? AUDIO_CONSTRAINTS
            : AUDIO_CONSTRAINTS_NO_DTLN,
        video: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      testStream = stream;
      bailIfDestroyed();

      if (model) {
        model.disconnectFromTransport();
        _dtln.setNoiseGate(noiseGateThreshold);
        const { processedStream, cleanup } = await model.monitorStream(stream);
        dtlnCleanup = cleanup;
        bailIfDestroyed();

        let source = ctx.createMediaStreamSource(processedStream);
        source.connect(ctx.destination); // plays processed audio

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        micLevelAnalyser = analyser;

        // DeepFilterNet3's node is rebuilt when its strength changes, and its
        // graphs go with it: play the new node's, peers still cut off.
        const rebuild = async () => {
          const next = await model.monitorStream(stream);
          if (rebuildMicTest !== rebuild) {
            // The test ended meanwhile: a monitor left behind would keep
            // peers cut off on every later mic rebuild.
            next.cleanup();
            model.reconnectToTransport();
            return;
          }
          model.disconnectFromTransport();
          dtlnCleanup = next.cleanup;
          source.disconnect();
          source = ctx.createMediaStreamSource(next.processedStream);
          source.connect(ctx.destination);
          source.connect(analyser);
        };
        if (picked.engine === "dfn3") rebuildMicTest = rebuild;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        micLevelInterval = setInterval(() => {
          analyser.getByteFrequencyData(dataArray);
          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
          micLevel = avg / 255;
        }, 50);

        micTestDisconnect = () => {
          rebuildMicTest = null;
          dtlnCleanup?.();
          model.reconnectToTransport();
          source.disconnect();
          ctx.close?.();
          stream.getTracks().forEach((t) => t.stop());
        };
      } else {
        // Standard (Non-DTLN) Path
        micTestAudio = new Audio();
        micTestAudio.srcObject = stream;
        micTestAudio.volume = 0.8;
        await micTestAudio.play();
        bailIfDestroyed();

        const analyser = ctx.createAnalyser();
        analyser.fftSize = 256;
        const source = ctx.createMediaStreamSource(stream);
        source.connect(analyser);
        micLevelAnalyser = analyser;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        micLevelInterval = setInterval(() => {
          analyser.getByteFrequencyData(dataArray);
          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
          micLevel = avg / 255;
        }, 50);

        micTestDisconnect = () => {
          micTestAudio?.pause();
          micTestAudio = null;
          source.disconnect();
          analyser.disconnect();
          ctx.close();
          stream.getTracks().forEach((t) => t.stop());
        };
      }
      // Setup succeeded - now it's a live test.
      isMicTesting = true;
    } catch (e) {
      console.error("Mic test failed:", e);
      rebuildMicTest = null;
      // Failure can land with the setup half-built and micTestDisconnect not
      // yet assigned: drop the monitor graph and the captured mic, then
      // restore the transport edge (safe no-op when nothing was cut) - or a
      // live call transmits silence from here on.
      dtlnCleanup?.();
      testStream?.getTracks().forEach((t) => t.stop());
      denoiser?.reconnectToTransport();
      micTestDisconnect?.();
      micTestDisconnect = null;
      void testCtx?.close().catch(() => {});
      // Once destroyed, onDestroy has already undeafened: twice would chime
      // twice and restore the pre-deafen volume over any change since.
      if (!destroyed) setDeafened(false);
      isMicTesting = false;
    } finally {
      isMicStarting = false;
    }
  }

  // Cleanup mic test when component is destroyed (modal closed)
  onDestroy(() => {
    destroyed = true;
    // Still starting: the start path tears down the rest at its next await,
    // but the deafen and the context it took first can't wait for that.
    if (isMicStarting) {
      void testCtx?.close().catch(() => {});
      setDeafened(false);
    }
    if (isMicTesting) {
      micTestDisconnect?.();
      micTestDisconnect = null;
      if (micLevelInterval) clearInterval(micLevelInterval);
      micLevelInterval = null;
      micLevelAnalyser?.disconnect();
      micLevelAnalyser = null;
      micLevel = 0;
      setDeafened(false);
      isMicTesting = false;
    }
  });
</script>

<div class="flex flex-col gap-6">
  <!-- Camera Section -->
  <div
    class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
  >
    <div class="flex items-center gap-2">
      <div class="w-1 h-4 bg-blue-500 rounded-full"></div>
      <Label
        class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
        >Camera</Label
      >
    </div>

    {#if cameras.devices.length > 0}
      <Select
        type="single"
        value={cameras.selected ?? ""}
        onValueChange={(v) => void setCamera(v || null)}
      >
        <SelectTrigger
          aria-label="Camera"
          class="bg-background border-input font-mono text-sm focus:ring-ring"
        >
          <span class="block truncate">
            {cameras.devices.find((d) => d.deviceId === cameras.selected)
              ?.label || "System default"}
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
      {#if cameras.unnamed}
        <p class="text-xs text-muted-foreground font-mono">
          Turn your camera on once and these get their real names - a browser
          withholds them until it has been allowed a camera.
        </p>
      {:else}
        <p class="text-xs text-muted-foreground font-mono">
          Changes take effect at once if your camera is on. A phone offering
          itself as a camera appears here as soon as it does.
        </p>
      {/if}
    {:else}
      <p class="text-xs text-muted-foreground font-mono">
        No cameras found on this device.
      </p>
    {/if}
  </div>

  <!-- Microphone Section -->
  <div
    class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
  >
    <div class="flex items-center gap-2">
      <div class="w-1 h-4 bg-green-500 rounded-full"></div>
      <Label
        class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
        >Microphone</Label
      >
    </div>

    {#if !devicesLoaded}
      <div class="h-9 w-full animate-pulse rounded-md bg-muted/60"></div>
    {:else if inputDevices.length > 0}
      <Select
        type="single"
        value={activeInput ?? ""}
        onValueChange={(v) => handleInputDeviceChange(v)}
      >
        <SelectTrigger
          aria-label="Microphone"
          class="bg-background border-input font-mono text-sm focus:ring-ring"
        >
          <span class="block truncate">
            {inputDevices.find((d) => d.deviceId === activeInput)?.label ||
              inputDevices.find((d) => d.deviceId === "")?.label ||
              "System default"}
          </span>
        </SelectTrigger>
        <SelectContent class="bg-popover border-border font-mono">
          {#each inputDevices as dev (dev.deviceId)}
            <SelectItem value={dev.deviceId} class="font-mono text-sm">
              <span class="block truncate">
                {dev.label || `Microphone ${dev.deviceId.slice(0, 8)}`}
              </span>
            </SelectItem>
          {/each}
        </SelectContent>
      </Select>
    {:else}
      <p class="text-xs text-muted-foreground font-mono">
        Join a call to select devices
      </p>
    {/if}

    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-xs font-mono text-muted-foreground">Input gain</span>
        <span class="text-xs font-mono tabular-nums text-green-400"
          >{gainToPercent(sliderToGain(inputSlider[0]))}</span
        >
      </div>
      <Slider
        aria-label="Input gain"
        type="multiple"
        bind:value={inputSlider}
        min={0}
        max={100}
        step={1}
        onValueChange={handleInputGainChange}
        class="w-full **:data-[orientation=vertical]:h-full"
      />
    </div>
  </div>

  <!-- Noise Suppression Section -->
  <div
    class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
  >
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <div class="w-1 h-4 bg-blue-500 rounded-full"></div>
        <Label
          class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
          >Noise Suppression</Label
        >
      </div>
      <label class="flex items-center gap-2 cursor-pointer">
        {#if rearming || voiceProcessing.loading}
          <span
            class="flex items-center gap-1 text-xs font-mono text-muted-foreground"
            role="status"
          >
            <Loader2 class="size-3 animate-spin" />
            {voiceProcessing.loading ? "Loading…" : "Applying…"}
          </span>
        {:else}
          <span
            class="text-xs font-mono {shownEngine !== 'browser'
              ? 'text-green-400'
              : 'text-muted-foreground'}"
          >
            {NOISE_ENGINE_LABELS[shownEngine]}
          </span>
        {/if}
        <Switch
          aria-label="Noise suppression"
          bind:checked={dtlnEnabled}
          onCheckedChange={(checked) => rearm(setVoiceDtlnEnabled(checked))}
        />
      </label>
    </div>

    {#if dtlnEnabled}
      <Select
        type="single"
        value={noiseEngine}
        onValueChange={(v) => handleNoiseEngineChange(v as NoiseEngine)}
      >
        <SelectTrigger
          aria-label="Noise suppression engine"
          class="bg-background border-input font-mono text-sm focus:ring-ring"
        >
          <span class="block truncate">{NOISE_ENGINE_LABELS[noiseEngine]}</span>
        </SelectTrigger>
        <SelectContent class="bg-popover border-border font-mono">
          <SelectItem value="dfn3" class="font-mono text-sm">DeepFilterNet</SelectItem>
          <SelectItem value="dtln" class="font-mono text-sm">DTLN</SelectItem>
        </SelectContent>
      </Select>
    {/if}
    {#if voiceProcessing.fallbackReason}
      <!-- Only DeepFilterNet falls back to DTLN; only DTLN falls back to the browser. -->
      <p class="text-xs text-muted-foreground" role="status">
        {#if voiceProcessing.engine === "dtln" && voiceProcessing.unsupported}
          DeepFilterNet can't run on this device ({voiceProcessing.fallbackReason}),
          so DTLN is active.
        {:else if voiceProcessing.engine === "dtln"}
          DeepFilterNet isn't available right now, so DTLN is active.
        {:else if noiseEngine === "dfn3"}
          Neither DeepFilterNet nor DTLN could run, so browser noise suppression
          is active.
        {:else}
          DTLN isn't available right now, so browser noise suppression is active.
        {/if}
        {#if !voiceProcessing.unsupported}
          It is tried again when you next join a call.
        {/if}
      </p>
    {/if}
    <!-- Applied on release: a new strength rebuilds DeepFilterNet3's node,
         and a call or mic test on it moves over (setVoiceDfnAttenuation). -->
    {#if dtlnEnabled && noiseEngine === "dfn3"}
      <details class="group rounded-md border border-border/70 bg-background/40">
        <summary class="flex cursor-pointer list-none items-center gap-2 px-3 py-2">
          <ChevronRight
            class="size-3 text-muted-foreground transition-transform group-open:rotate-90"
          />
          <span class="min-w-0 flex-1 text-xs font-mono text-muted-foreground"
            >Advanced settings</span
          >
          {#if applyingDfn}
            <span
              class="flex items-center gap-1 text-xs font-mono text-muted-foreground"
              role="status"
            >
              <Loader2 class="size-3 animate-spin" /> Applying…
            </span>
          {/if}
        </summary>
        <div class="flex flex-col gap-3 px-3 pb-3">
          <div class="flex flex-col gap-2">
            <div class="flex items-center justify-between">
              <span class="flex items-center gap-1 text-xs font-mono text-muted-foreground">
                Strength while speaking
                <Tip
                  text="How much background noise is removed while you talk. Higher removes more but can make your voice sound thin or clipped."
                >
                  {#snippet children(props)}
                    <button
                      {...props}
                      type="button"
                      aria-label="About strength while speaking"
                      class="text-muted-foreground hover:text-foreground"
                    >
                      <Info class="size-3" />
                    </button>
                  {/snippet}
                </Tip>
              </span>
              <span class="text-xs font-mono tabular-nums text-blue-400">{dfnSpeechDb} dB</span>
            </div>
            <Slider
              aria-label="Strength while speaking"
              type="single"
              bind:value={dfnSpeechDb}
              min={DFN_SPEECH_DB.min}
              max={DFN_SPEECH_DB.max}
              step={1}
              disabled={dfnBusy}
              onValueChange={clampDfnSliders}
              onValueCommit={applyDfnStrength}
              class="w-full"
            />
          </div>
          <div class="flex flex-col gap-2">
            <div class="flex items-center justify-between">
              <span class="flex items-center gap-1 text-xs font-mono text-muted-foreground">
                Strength in pauses
                <Tip
                  text="How far noise is pushed down between words. Higher is quieter between words; too high can sound like the mic cutting in and out."
                >
                  {#snippet children(props)}
                    <button
                      {...props}
                      type="button"
                      aria-label="About strength in pauses"
                      class="text-muted-foreground hover:text-foreground"
                    >
                      <Info class="size-3" />
                    </button>
                  {/snippet}
                </Tip>
              </span>
              <span class="text-xs font-mono tabular-nums text-blue-400">{dfnPauseDb} dB</span>
            </div>
            <Slider
              aria-label="Strength in pauses"
              type="single"
              bind:value={dfnPauseDb}
              min={DFN_PAUSE_DB.min}
              max={DFN_PAUSE_DB.max}
              step={1}
              disabled={dfnBusy}
              onValueChange={clampDfnSliders}
              onValueCommit={applyDfnStrength}
              class="w-full"
            />
          </div>
          <Button
            variant="outline"
            size="sm"
            class="self-start font-mono text-xs"
            onclick={resetDfnStrength}
            disabled={dfnBusy ||
              (dfnSpeechDb === DFN_DEFAULT_SPEECH_DB && dfnPauseDb === DFN_DEFAULT_PAUSE_DB)}
          >
            Reset to defaults
          </Button>
        </div>
      </details>
    {/if}
    <!-- The gate is DTLN's; DeepFilterNet3 gates pauses by itself. -->
    {#if shownEngine === "dtln"}
      <div class="flex flex-col gap-2 pl-3 border-l-2 border-blue-500/30">
        <div class="flex items-center justify-between">
          <span class="text-xs font-mono text-muted-foreground"
            >Gate threshold</span
          >
          <span class="text-xs font-mono tabular-nums text-blue-400"
            >{noiseGateThreshold.toFixed(4)}</span
          >
        </div>
        <Slider
          aria-label="Gate threshold"
          type="single"
          value={noiseGateSlider[0]}
          min={0}
          max={100}
          step={1}
          onValueChange={(val: number) => {
            noiseGateSlider = [val];
            noiseGateThreshold = val / 10000;
            setVoiceDtlnNoiseGate(noiseGateThreshold);
          }}
          class="w-full"
        />
        <p class="text-[10px] text-muted-foreground font-mono mt-1">
          Lower = more sensitive • Higher = blocks more noise
        </p>
      </div>
    {/if}

    <Button
      variant={isMicTesting ? "destructive" : "outline"}
      size="sm"
      class="w-full font-mono text-xs mt-2"
      onclick={handleMicTest}
      disabled={isMicStarting || applyingDfn}
    >
      {isMicTesting ? "■ Stop test" : isMicStarting ? "Loading…" : "▶ Test mic (hear yourself)"}
    </Button>

    {#if isMicTesting}
      <div class="flex flex-col gap-1">
        <div class="flex items-center justify-between text-[10px] font-mono">
          <span class="text-muted-foreground">Mic level</span>
          <span class="text-muted-foreground"
            >{Math.round(micLevel * 100)}%</span
          >
        </div>
        <div class="h-2 bg-muted rounded-full overflow-hidden">
          <div
            class="h-full bg-linear-to-r from-green-400 to-green-500 rounded-full transition-all duration-75"
            style="width: {micLevel * 100}%"
          ></div>
        </div>
        {#if micTestNotice}
          <p class="text-xs text-muted-foreground" role="status">{micTestNotice}</p>
        {/if}
      </div>
    {/if}
  </div>

  <!-- Speakers Section -->
  <div
    class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
  >
    <div class="flex items-center gap-2">
      <div class="w-1 h-4 bg-orange-500 rounded-full"></div>
      <Label
        class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
        >Speakers</Label
      >
    </div>

    {#if !devicesLoaded}
      <div class="h-9 w-full animate-pulse rounded-md bg-muted/60"></div>
    {:else if outputDevices.length > 0}
      <Select
        type="single"
        value={activeOutput ?? ""}
        onValueChange={(v) => handleOutputDeviceChange(v)}
      >
        <SelectTrigger
          aria-label="Speakers"
          class="bg-background border-input font-mono text-sm focus:ring-ring"
        >
          <span class="block truncate">
            {outputDevices.find((d) => d.deviceId === activeOutput)?.label ||
              outputDevices.find((d) => d.deviceId === "")?.label ||
              "System default"}
          </span>
        </SelectTrigger>
        <SelectContent class="bg-popover border-border font-mono">
          {#each outputDevices as dev (dev.deviceId)}
            <SelectItem value={dev.deviceId} class="font-mono text-sm">
              <span class="block truncate">
                {dev.label || `Speaker ${dev.deviceId.slice(0, 8)}`}
              </span>
            </SelectItem>
          {/each}
        </SelectContent>
      </Select>
    {:else}
      <p class="text-xs text-muted-foreground font-mono">
        Join a call to select devices
      </p>
    {/if}

    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="text-xs font-mono text-muted-foreground"
          >Output volume</span
        >
        <span class="text-xs font-mono tabular-nums text-orange-400"
          >{gainToPercent(sliderToGain(outputSlider[0]))}</span
        >
      </div>
      <Slider
        aria-label="Output volume"
        type="multiple"
        bind:value={outputSlider}
        min={0}
        max={100}
        step={1}
        onValueChange={handleOutputVolumeChange}
        class="w-full"
      />
    </div>
  </div>

  <!-- Screen Share Audio Section -->
  <div
    class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
  >
    <div class="flex items-center justify-between">
      <div class="flex items-center gap-2">
        <div class="w-1 h-4 bg-purple-500 rounded-full"></div>
        <Label
          class="select-none text-xs font-mono text-muted-foreground uppercase tracking-wider"
          >Screen Share Audio</Label
        >
      </div>
      <Switch
        aria-label="Send screen share audio even when echo prevention is unavailable"
        bind:checked={shareAudioDespiteEchoRisk}
        onCheckedChange={(checked) => setShareAudioDespiteEchoRisk(checked)}
      />
    </div>
    <p class="text-[10px] text-muted-foreground font-mono">
      A screen share's audio is only sent when awful.chat can confirm it
      will not echo everyone's own voice back to them (a per-window share
      on Windows 11 / macOS 14.2+, or any share with the browser's
      own-audio filter confirmed on). When it can't confirm that, audio is
      dropped by default. Turn this on to send it anyway - people may hear
      themselves with a delay.
    </p>
  </div>
</div>
