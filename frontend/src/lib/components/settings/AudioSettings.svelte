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
  import {
    setVoiceInputDevice,
    getVoiceInputDevices,
    getVoiceActiveInputDevice,
    setVoiceInputGain,
    getVoiceInputGain,
    setVoiceOutputDevice,
    getVoiceOutputDevices,
    getVoiceActiveOutputDevice,
    setVoiceOutputVolume,
    getVoiceOutputVolume,
    setVoiceDtlnNoiseGate,
    setVoiceDtlnEnabled,
    getVoiceDtlnEnabled,
    transportState,
    setDeafened,
    _dtln,
    toggleMute,
  } from "$lib/transport.svelte";

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
  let activeInput = $state<string | null>(null);
  let activeOutput = $state<string | null>(null);

  let dtlnEnabled = $state(getVoiceDtlnEnabled());
  let noiseGateThreshold = $state(0.002);
  let noiseGateSlider = $state<number[]>([0.002 * 10000]);

  let isMicTesting = $state(false);
  let micTestDisconnect: (() => void) | null = null;
  let micLevel = $state(0);
  let micLevelInterval: ReturnType<typeof setInterval> | null = null;
  let micLevelAnalyser: AnalyserNode | null = null;
  let micTestAudio: HTMLAudioElement | null = null;

  const LOG_MIN = Math.log10(0.01);
  const LOG_MAX = Math.log10(2.5);

  function gainToSlider(gain: number): number {
    if (gain <= 0) return 0;
    const logVal = Math.log10(Math.max(0.01, gain));
    return Math.round(((logVal - LOG_MIN) / (LOG_MAX - LOG_MIN)) * 99 + 1);
  }

  function sliderToGain(slider: number): number {
    if (slider <= 0) return 0;
    const t = (slider - 1) / 99;
    return Math.pow(10, LOG_MIN + t * (LOG_MAX - LOG_MIN));
  }

  function gainToPercent(gain: number): string {
    if (gain <= 0) return "muted";
    return `${Math.round(gain * 100)}%`;
  }

  let inputSlider = $state<number[]>([gainToSlider(1.0)]);
  let outputSlider = $state<number[]>([gainToSlider(1.0)]);

  $effect(() => {
    activeInput = getVoiceActiveInputDevice();
    activeOutput = getVoiceActiveOutputDevice();
    inputSlider = [gainToSlider(getVoiceInputGain())];
    outputSlider = [gainToSlider(getVoiceOutputVolume())];
    getVoiceInputDevices().then((d) => {
      inputDevices = d;
    });
    getVoiceOutputDevices().then((d) => {
      outputDevices = d;
    });
  });

  function handleInputGainChange(vals: number[]) {
    inputSlider = vals;
    const gain = sliderToGain(vals[0]);
    setVoiceInputGain(gain);
    if (gain <= 0 && !transportState.muted) toggleMute();
    else if (gain > 0 && transportState.muted) toggleMute();
  }

  function handleOutputVolumeChange(vals: number[]) {
    outputSlider = vals;
    setVoiceOutputVolume(sliderToGain(vals[0]));
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

      if (dtlnEnabled) {
        _dtln.disconnectFromTransport();
        await _dtln.waitUntilReady();
        _dtln.setNoiseGate(noiseGateThreshold);
        const { processedStream, cleanup: dtlnCleanup } =
          await _dtln.monitorStream(stream);

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
          dtlnCleanup();
          _dtln.reconnectToTransport();
          source.disconnect();
          testCtx.close?.();
          stream.getTracks().forEach((t) => t.stop());
          isMicTesting = false;
        };
        isMicTesting = true;
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

      isMicTesting = true;
    } catch (e) {
      console.error("Mic test failed:", e);
      micTestDisconnect?.();
      micTestDisconnect = null;
      setDeafened(false);
      isMicTesting = false;
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

    {#if inputDevices.length > 0}
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
              "System Default"}
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
        <span class="text-xs font-mono text-muted-foreground">Input Gain</span>
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
    class="flex flex-col gap-3 p-4 bg-muted/30 rounded-lg border border-border/50"
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
          onCheckedChange={() => setVoiceDtlnEnabled(dtlnEnabled)}
        />
      </label>
    </div>

    {#if dtlnEnabled}
      <div class="flex flex-col gap-2 pl-3 border-l-2 border-blue-500/30">
        <div class="flex items-center justify-between">
          <span class="text-xs font-mono text-muted-foreground"
            >Gate Threshold</span
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
    >
      {isMicTesting ? "■ Stop Test" : "▶ Test Mic (hear yourself)"}
    </Button>

    {#if isMicTesting}
      <div class="flex flex-col gap-1">
        <div class="flex items-center justify-between text-[10px] font-mono">
          <span class="text-muted-foreground">Mic Level</span>
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

    {#if outputDevices.length > 0}
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
              "System Default"}
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
          >Output Volume</span
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
