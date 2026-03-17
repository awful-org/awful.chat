<script lang="ts">
  import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog";
  import { Label } from "$lib/components/ui/label";
  import { Slider } from "$lib/components/ui/slider";
  import {
    Select,
    SelectContent,
    SelectItem,
    SelectTrigger,
  } from "$lib/components/ui/select";
  import { Input } from "$lib/components/ui/input";
  import { Separator } from "$lib/components/ui/separator";
  import AvatarPickerDialog from "$lib/components/AvatarPickerDialog.svelte";
  import { Button } from "$lib/components/ui/button";
  import { profileStore, saveName } from "$lib/profile.svelte";
  import { wipeLocalDatabase } from "$lib/storage";
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
    transportState,
    toggleMute,
  } from "$lib/transport.svelte";

  interface Props {
    open: boolean;
    onClose: () => void;
  }

  let { open = $bindable(), onClose }: Props = $props();

  let inputDevices = $state<MediaDeviceInfo[]>([]);
  let outputDevices = $state<MediaDeviceInfo[]>([]);
  let activeInput = $state<string | null>(null);
  let activeOutput = $state<string | null>(null);
  let avatarDialogOpen = $state(false);
  let nameValue = $state("");
  let confirmErase = $state(false);

  const LOG_MIN = Math.log10(0.01); // -2
  const LOG_MAX = Math.log10(2.5); // ~0.398

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
    if (!open) return;
    nameValue = profileStore.nickname;
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
    activeInput = deviceId;
    await setVoiceInputDevice(deviceId);
  }

  async function handleOutputDeviceChange(deviceId: string) {
    activeOutput = deviceId;
    await setVoiceOutputDevice(deviceId);
  }

  async function handleNameBlur() {
    const trimmed = nameValue.trim();
    if (trimmed && trimmed !== profileStore.nickname) {
      await saveName(trimmed);
    }
  }

  async function handleEraseLocalData() {
    await wipeLocalDatabase();
    window.location.reload();
  }

  const profileInitial = $derived(
    (profileStore.nickname || nameValue || "?").charAt(0).toUpperCase()
  );
</script>

<Dialog
  bind:open
  onOpenChange={(v) => {
    if (!v) onClose();
  }}
>
  <DialogContent
    overlayClass="z-30"
    class="bg-card border-border text-card-foreground font-mono max-w-md max-h-[90vh] overflow-y-auto z-30"
  >
    <DialogHeader>
      <DialogTitle class="font-mono text-base font-semibold"
        >Settings</DialogTitle
      >
    </DialogHeader>

    <div class="flex flex-col gap-5 pt-1">
      <div class="flex flex-col gap-3">
        <p
          class="text-xs text-muted-foreground font-mono uppercase tracking-widest"
        >
          Profile
        </p>
        <div class="flex flex-col items-center gap-3">
          <button
            type="button"
            onclick={() => {
              avatarDialogOpen = true;
            }}
            aria-label="Change avatar"
            class="relative group flex size-24 items-center justify-center rounded-full overflow-hidden bg-primary/20 ring-2 ring-border hover:ring-primary/60 transition-all cursor-pointer shrink-0"
          >
            {#if profileStore.avatarUrl}
              <img
                src={profileStore.avatarUrl}
                alt="Avatar"
                class="size-full object-cover"
              />
            {:else}
              <span
                class="text-3xl font-semibold text-primary font-mono select-none"
                >{profileInitial}</span
              >
            {/if}
            <div
              class="absolute inset-0 rounded-full flex items-center justify-center bg-black/60 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <span class="text-white text-[10px] font-mono">edit</span>
            </div>
          </button>
          <Input
            bind:value={nameValue}
            onblur={handleNameBlur}
            onkeydown={(e) => {
              if (e.key === "Enter") (e.target as HTMLInputElement).blur();
            }}
            placeholder="Display name"
            class="bg-background border-input text-foreground placeholder:text-muted-foreground font-mono focus-visible:ring-ring text-center w-full"
          />
        </div>
      </div>

      <Separator class="bg-border" />

      <div class="flex flex-col gap-2">
        <Label
          class="text-xs font-mono text-muted-foreground uppercase tracking-widest"
          >microphone</Label
        >
        {#if inputDevices.length > 0}
          <Select
            type="single"
            value={activeInput ?? undefined}
            onValueChange={handleInputDeviceChange}
          >
            <SelectTrigger
              class="bg-background border-input font-mono text-sm focus:ring-ring"
            >
              <span class="block max-w-65 truncate">
                {inputDevices.find((d) => d.deviceId === activeInput)?.label ||
                  "Default"}
              </span>
            </SelectTrigger>
            <SelectContent class="bg-popover border-border font-mono">
              {#each inputDevices as dev (dev.deviceId)}
                <SelectItem value={dev.deviceId} class="font-mono text-sm">
                  <span class="block max-w-65 truncate">
                    {dev.label || `Microphone ${dev.deviceId.slice(0, 8)}`}
                  </span>
                </SelectItem>
              {/each}
            </SelectContent>
          </Select>
        {:else}
          <p class="text-xs text-muted-foreground font-mono">
            join a call to select devices
          </p>
        {/if}
      </div>

      <!-- Input gain -->
      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <Label
            class="text-xs font-mono text-muted-foreground uppercase tracking-widest"
            >input gain</Label
          >
          <span class="text-xs font-mono text-foreground tabular-nums"
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
          class="w-full"
        />
        <div
          class="flex justify-between text-[10px] text-muted-foreground font-mono"
        >
          <span>mute</span>
          <span>100%</span>
          <span>250%</span>
        </div>
      </div>

      <Separator class="bg-border" />

      <!-- Output device -->
      <div class="flex flex-col gap-2">
        <Label
          class="text-xs font-mono text-muted-foreground uppercase tracking-widest"
          >speakers</Label
        >
        {#if outputDevices.length > 0}
          <Select
            type="single"
            value={activeOutput ?? undefined}
            onValueChange={handleOutputDeviceChange}
          >
            <SelectTrigger
              class="bg-background border-input font-mono text-sm focus:ring-ring"
            >
              <span class="block max-w-[260px] truncate">
                {outputDevices.find((d) => d.deviceId === activeOutput)
                  ?.label || "Default"}
              </span>
            </SelectTrigger>
            <SelectContent class="bg-popover border-border font-mono">
              {#each outputDevices as dev (dev.deviceId)}
                <SelectItem value={dev.deviceId} class="font-mono text-sm">
                  <span class="block max-w-[260px] truncate">
                    {dev.label || `Speaker ${dev.deviceId.slice(0, 8)}`}
                  </span>
                </SelectItem>
              {/each}
            </SelectContent>
          </Select>
        {:else}
          <p class="text-xs text-muted-foreground font-mono">
            join a call to select devices
          </p>
        {/if}
      </div>

      <!-- Output volume -->
      <div class="flex flex-col gap-2">
        <div class="flex items-center justify-between">
          <Label
            class="text-xs font-mono text-muted-foreground uppercase tracking-widest"
            >output volume</Label
          >
          <span class="text-xs font-mono text-foreground tabular-nums"
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
        <div
          class="flex justify-between text-[10px] text-muted-foreground font-mono"
        >
          <span>mute</span>
          <span>100%</span>
          <span>250%</span>
        </div>
      </div>

      <Separator class="bg-border" />

      <div class="flex flex-col gap-2">
        <Label
          class="text-xs font-mono text-destructive uppercase tracking-widest"
          >Danger zone</Label
        >
        <p class="text-xs text-muted-foreground font-mono">
          Permanently erase all local chat text, media, rooms, profiles, and
          identity data stored in IndexedDB.
        </p>
        {#if !confirmErase}
          <Button
            variant="destructive"
            class="w-full font-mono"
            onclick={() => (confirmErase = true)}
          >
            Erase all local data
          </Button>
        {:else}
          <div class="grid grid-cols-2 gap-2">
            <Button
              variant="outline"
              class="font-mono"
              onclick={() => (confirmErase = false)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              class="font-mono"
              onclick={handleEraseLocalData}
            >
              Confirm erase
            </Button>
          </div>
        {/if}
      </div>
    </div>
  </DialogContent>
</Dialog>

<AvatarPickerDialog
  open={avatarDialogOpen}
  onClose={() => {
    avatarDialogOpen = false;
  }}
/>
