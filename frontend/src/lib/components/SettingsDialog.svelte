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
    Drawer,
    DrawerContent,
    DrawerHeader,
    DrawerTitle,
  } from "$lib/components/ui/drawer";
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
  import {
    enroll,
    identityStore,
    lock,
    removeWebAuthn,
  } from "$lib/identity.svelte";
  import { deleteCookie } from "$lib/utils";

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

  let biometricPassword = $state("");
  let biometricLoading = $state(false);
  let biometricError = $state<string | null>(null);
  let biometricSuccess = $state(false);
  let confirmRemoveBiometric = $state(false);

  let rememberDuration = $state(
    parseInt(localStorage.getItem("awful_remember_duration") ?? "15", 10)
  );
  let rememberResetTimer = $state(
    localStorage.getItem("awful_remember_reset_timer") === "true"
  );

  const canEnrollBiometrics = $derived(
    !identityStore.hasWebAuthn &&
      (identityStore.webAuthnCapabilities?.canEnroll ?? false)
  );

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

  const closeHandler = (v: boolean) => {
    if (!v) onClose();
  };

  let isMobile = $state(false);

  $effect(() => {
    if (typeof window === "undefined") return;

    const media = window.matchMedia("(max-width: 639px)");

    const update = () => {
      isMobile = media.matches;
    };

    update();
    media.addEventListener("change", update);

    return () => media.removeEventListener("change", update);
  });
</script>

{#snippet SettingsContent()}
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
            <span class="block max-w-65 truncate">
              {outputDevices.find((d) => d.deviceId === activeOutput)?.label ||
                "Default"}
            </span>
          </SelectTrigger>
          <SelectContent class="bg-popover border-border font-mono">
            {#each outputDevices as dev (dev.deviceId)}
              <SelectItem value={dev.deviceId} class="font-mono text-sm">
                <span class="block max-w-65 truncate">
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

    {#if canEnrollBiometrics || identityStore.hasWebAuthn}
      <Separator class="bg-border" />
      <div class="flex flex-col gap-3">
        <Label
          class="text-xs font-mono text-muted-foreground uppercase tracking-widest"
        >
          security
        </Label>

        {#if identityStore.hasWebAuthn}
          <p class="text-xs text-muted-foreground font-mono">
            Biometric / device PIN unlock is enabled.
          </p>
          {#if !confirmRemoveBiometric}
            <Button
              variant="outline"
              class="w-full font-mono"
              onclick={() => (confirmRemoveBiometric = true)}
            >
              Remove biometric unlock
            </Button>
          {:else}
            <div class="grid grid-cols-2 gap-2">
              <Button
                variant="outline"
                class="font-mono"
                onclick={() => (confirmRemoveBiometric = false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                class="font-mono"
                onclick={async () => {
                  await removeWebAuthn();
                  confirmRemoveBiometric = false;
                }}
              >
                Confirm remove
              </Button>
            </div>
          {/if}
        {:else}
          <p class="text-xs text-muted-foreground font-mono">
            Use your device biometrics or PIN to unlock instead of typing your
            password.
          </p>
          <div class="flex flex-col gap-2">
            <Input
              type="password"
              bind:value={biometricPassword}
              placeholder="confirm your password to enroll"
              class="bg-background border-input font-mono focus-visible:ring-ring
          {biometricError
                ? 'border-destructive focus-visible:ring-destructive'
                : ''}"
            />
            {#if biometricError}
              <p class="text-xs text-destructive font-mono">{biometricError}</p>
            {/if}
            {#if biometricSuccess}
              <p class="text-xs text-green-500 font-mono">
                Biometric unlock enabled.
              </p>
            {/if}
            <Button
              variant="outline"
              class="w-full font-mono"
              disabled={biometricPassword.length === 0 || biometricLoading}
              onclick={async () => {
                biometricError = null;
                biometricSuccess = false;
                biometricLoading = true;
                try {
                  // verify password is correct first by attempting a decrypt
                  await enroll(biometricPassword);
                  biometricPassword = "";
                  biometricSuccess = true;
                } catch (e) {
                  biometricError = e instanceof Error ? e.message : String(e);
                } finally {
                  biometricLoading = false;
                }
              }}
            >
              {biometricLoading
                ? "waiting for device…"
                : "Enable biometric unlock"}
            </Button>
          </div>
        {/if}
      </div>
    {/if}

    <Separator class="bg-border" />

    <div class="flex flex-col gap-2">
      <Label
        class="text-xs font-mono text-muted-foreground uppercase tracking-widest"
      >
        session
      </Label>

      <div class="flex flex-col gap-1">
        <Label class="text-xs text-muted-foreground font-mono">
          Remember password for
        </Label>
        <Select
          type="single"
          value={rememberDuration.toString()}
          onValueChange={(v: string) => {
            const val = parseInt(v, 10);
            rememberDuration = val;
            localStorage.setItem("awful_remember_duration", v);
          }}
        >
          <SelectTrigger class="w-full font-mono">
            <span class="text-xs">
              {rememberDuration === -1
                ? "Until I log out"
                : `${rememberDuration} days`}
            </span>
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="5">5 days</SelectItem>
            <SelectItem value="15">15 days</SelectItem>
            <SelectItem value="30">30 days</SelectItem>
            <SelectItem value="60">60 days</SelectItem>
            <SelectItem value="-1">Until I log out</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <label class="flex items-center gap-2 text-xs text-muted-foreground font-mono cursor-pointer">
        <input
          type="checkbox"
          bind:checked={rememberResetTimer}
          onchange={() => {
            localStorage.setItem("awful_remember_reset_timer", String(rememberResetTimer));
          }}
          class="accent-primary"
        />
        Reset timer after each login
      </label>

      <Button
        variant="outline"
        class="w-full font-mono mt-2"
        onclick={() => {
          deleteCookie("awful_password");
          lock();
        }}
      >
        Lock / Logout
      </Button>
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
{/snippet}

{#if isMobile}
  <Drawer bind:open onOpenChange={closeHandler} direction="bottom">
    <DrawerContent
      class="bg-card text-card-foreground border-border max-h-[90vh]"
    >
      <DrawerHeader
        class="px-4 py-3 w-full flex items-center justify-between gap-2"
      >
        <DrawerTitle class="font-mono text-base font-semibold"
          >Settings</DrawerTitle
        >
      </DrawerHeader>
      <div class="overflow-y-auto px-4 pb-4">
        {@render SettingsContent()}
      </div>
    </DrawerContent>
  </Drawer>
{:else}
  <Dialog bind:open onOpenChange={closeHandler}>
    <DialogContent
      overlayClass="z-30"
      class="bg-card border-border text-card-foreground font-mono max-w-md max-h-[90vh] overflow-y-auto z-30"
    >
      <DialogHeader>
        <DialogTitle class="font-mono text-base font-semibold"
          >Settings</DialogTitle
        >
      </DialogHeader>
      {@render SettingsContent()}
    </DialogContent>
  </Dialog>
{/if}

<AvatarPickerDialog
  open={avatarDialogOpen}
  onClose={() => {
    avatarDialogOpen = false;
  }}
/>
