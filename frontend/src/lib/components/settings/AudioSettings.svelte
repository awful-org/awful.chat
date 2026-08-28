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
  import { transportState, _dtln } from "$lib/transport/transport.svelte";
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
    setVoiceDtlnEnabled,
    setVoiceDtlnNoiseGate,
    getVoiceDtlnNoiseGate,
  } from "$lib/transport/voice.svelte";
  import { setDeafened, toggleMute } from "$lib/transport/call.svelte";
  import {
    formatGain,
    gainToSlider,
    sliderToGain,
  } from "$lib/audio/volume-curve";

  const AUDIO_CONSTRAINTS: MediaTrackConstraints = {
    echoCancellation: false,
    noiseSuppression: false,
    autoGainControl: false,
  };

  const AUDIO_CONSTRAINTS_NO_DTLN: MediaTrackConstraints = {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: false,
  };

  let inputDevices = $state<MediaDeviceInfo[]>([]);
  let outputDevices = $state<MediaDeviceInfo[]>([]);
  // Device enumeration is async: swapping the fallback line for the taller
  // Select once it lands shifted the whole tab. A select-sized skeleton
  // holds the height until we know which one renders.
  let devicesLoaded = $state(false);
  let activeInput = $state<string | null>(null);
  let activeOutput = $state<string | null>(null);

  let dtlnEnabled = $state(getVoiceDtlnEnabled());
  // Restored from the last session, not a fresh default.
  let noiseGateThreshold = $state(getVoiceDtlnNoiseGate());
  let noiseGateSlider = $state<number[]>([getVoiceDtlnNoiseGate() * 10000]);

  let isMicTesting = $state(false);
  // Distinct from isMicTesting: set only during async startup so a second
  // click can't stop-then-orphan a test that hasn't finished starting.
  let isMicStarting = $state(false);
  let micTestDisconnect: (() => void) | null = null;
  let micLevel = $state(0);
  let micLevelInterval: ReturnType<typeof setInterval> | null = null;
  let micLevelAnalyser: AnalyserNode | null = null;
  let micTestAudio: HTMLAudioElement | null = null;

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

    try {
      // Deafen when starting test (mutes both input and output)
      setDeafened(true);

      // DTLN handles its own noise suppression, so we disable native ones if enabled
      const constraints: MediaStreamConstraints = {
        audio: activeInput
          ? {
              ...(dtlnEnabled ? AUDIO_CONSTRAINTS : AUDIO_CONSTRAINTS_NO_DTLN),
              deviceId: { exact: activeInput },
            }
          : dtlnEnabled
            ? AUDIO_CONSTRAINTS
            : AUDIO_CONSTRAINTS_NO_DTLN,
        video: false,
      };

      const stream = await navigator.mediaDevices.getUserMedia(constraints);
      testStream = stream;

      if (dtlnEnabled) {
        _dtln.disconnectFromTransport();
        await _dtln.waitUntilReady();
        _dtln.setNoiseGate(noiseGateThreshold);
        const { processedStream, cleanup } = await _dtln.monitorStream(stream);
        dtlnCleanup = cleanup;

        const testCtx = new AudioContext();
        const source = testCtx.createMediaStreamSource(processedStream);
        source.connect(testCtx.destination); // plays processed audio

        const analyser = testCtx.createAnalyser();
        analyser.fftSize = 256;
        source.connect(analyser);
        micLevelAnalyser = analyser;

        const dataArray = new Uint8Array(analyser.frequencyBinCount);
        micLevelInterval = setInterval(() => {
          analyser.getByteFrequencyData(dataArray);
          const avg = dataArray.reduce((a, b) => a + b, 0) / dataArray.length;
          micLevel = avg / 255;
        }, 50);

        micTestDisconnect = () => {
          dtlnCleanup?.();
          _dtln.reconnectToTransport();
          source.disconnect();
          testCtx.close?.();
          stream.getTracks().forEach((t) => t.stop());
        };
      } else {
        // Standard (Non-DTLN) Path
        micTestAudio = new Audio();
        micTestAudio.srcObject = stream;
        micTestAudio.volume = 0.8;
        await micTestAudio.play();

        const audioCtx = new AudioContext();
        const analyser = audioCtx.createAnalyser();
        analyser.fftSize = 256;
        const source = audioCtx.createMediaStreamSource(stream);
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
          audioCtx.close();
          stream.getTracks().forEach((t) => t.stop());
        };
      }
      // Setup succeeded - now it's a live test.
      isMicTesting = true;
    } catch (e) {
      console.error("Mic test failed:", e);
      // Failure can land with the setup half-built and micTestDisconnect not
      // yet assigned: drop the monitor graph and the captured mic, then
      // restore the transport edge (safe no-op when nothing was cut) - or a
      // live call transmits silence from here on.
      dtlnCleanup?.();
      testStream?.getTracks().forEach((t) => t.stop());
      _dtln.reconnectToTransport();
      micTestDisconnect?.();
      micTestDisconnect = null;
      setDeafened(false);
      isMicTesting = false;
    } finally {
      isMicStarting = false;
    }
  }

  // Cleanup mic test when component is destroyed (modal closed)
  onDestroy(() => {
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
  <!-- Microphone Section -->
  <div
    class="flex flex-col gap-4 p-4 bg-muted/30 rounded-lg border border-border/50"
  >
    <div class="flex items-center gap-2">
      <div class="w-1 h-4 bg-green-500 rounded-full"></div>
      <Label
        class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
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
          class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
          >Noise Suppression</Label
        >
      </div>
      <label class="flex items-center gap-2 cursor-pointer">
        <span
          class="text-xs font-mono {dtlnEnabled
            ? 'text-green-400'
            : 'text-muted-foreground'}"
        >
          {dtlnEnabled ? "DTLN" : "Browser"}
        </span>
        <Switch
          bind:checked={dtlnEnabled}
          onCheckedChange={(checked) => setVoiceDtlnEnabled(checked)}
        />
      </label>
    </div>

    {#if dtlnEnabled}
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
      disabled={isMicStarting}
    >
      {isMicTesting ? "■ Stop test" : "▶ Test mic (hear yourself)"}
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
        class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
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
</div>
