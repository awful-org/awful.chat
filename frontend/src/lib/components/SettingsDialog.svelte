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
  import DeviceSyncDialog from "$lib/components/DeviceSyncDialog.svelte";
  import {
    QrCode,
    Camera,
    HardDrive,
    File,
    MessageSquare,
    Users,
    Database,
    ChartPie,
    User,
    Volume2,
    RefreshCw,
    LogOut,
  } from "@lucide/svelte";
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
  import {
    wipeLocalDatabase,
    getStorageMetrics,
    type StorageMetrics,
  } from "$lib/storage";
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

  type SettingsTab = "profile" | "audio" | "session" | "data";

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
  let syncDialogOpen = $state(false);
  let syncDialogMode: "generate-qr" | "scan-qr" = $state("generate-qr");
  let nameValue = $state("");
  let confirmErase = $state(false);
  let activeTab = $state<SettingsTab>("profile");
  let metrics = $state<StorageMetrics | null>(null);

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

  const tabs = $state([
    { id: "profile" as SettingsTab, label: "Profile", icon: User },
    { id: "audio" as SettingsTab, label: "Audio", icon: Volume2 },
    { id: "session" as SettingsTab, label: "Session/Sync", icon: RefreshCw },
    {
      id: "data" as SettingsTab,
      label: "Data",
      icon: ChartPie,
    },
  ]);

  const canEnrollBiometrics = $derived(
    !identityStore.hasWebAuthn &&
      (identityStore.webAuthnCapabilities?.canEnroll ?? false)
  );

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

  $effect(() => {
    if (open && activeTab === "data" && !metrics) {
      getStorageMetrics()
        .then((m) => {
          metrics = m;
        })
        .catch(() => {
          metrics = null;
        });
    }
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

  function formatBytes(bytes: number | undefined): string {
    if (!bytes || bytes === 0) return "0 B";
    const k = 1024;
    const sizes = ["B", "KB", "MB", "GB"];
    const i = Math.min(
      Math.floor(Math.log(bytes) / Math.log(k)),
      sizes.length - 1
    );
    return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + " " + sizes[i];
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

  function handleLockLogout() {
    deleteCookie("awful_password");
    lock();
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

{#snippet TabBar()}
  <div
    class="flex flex-row sm:flex-col gap-1 p-1 bg-muted rounded-lg md:h-full"
  >
    {#each tabs as tab}
      <button
        type="button"
        onclick={() => (activeTab = tab.id)}
        class="flex-1 sm:flex-none flex items-center justify-center sm:justify-start gap-2 px-3 py-2 rounded-md text-xs font-mono transition-colors whitespace-nowrap {activeTab ===
        tab.id
          ? 'bg-background text-foreground shadow-sm'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted-foreground/10'}"
      >
        <tab.icon class="w-4 h-4" />
        <span class="hidden sm:inline">{tab.label}</span>
      </button>
    {/each}
  </div>
{/snippet}

{#snippet ProfileSection()}
  <div class="flex flex-col gap-5">
    <div class="flex flex-col gap-3">
      <div class="flex flex-col items-center gap-3">
        <button
          type="button"
          onclick={() => {
            avatarDialogOpen = true;
          }}
          aria-label="Change avatar"
          class="relative group flex size-20 items-center justify-center rounded-full overflow-hidden bg-primary/20 ring-2 ring-border hover:ring-primary/60 transition-all cursor-pointer shrink-0"
        >
          {#if profileStore.avatarUrl}
            <img
              src={profileStore.avatarUrl}
              alt="Avatar"
              class="size-full object-cover"
            />
          {:else}
            <span
              class="text-2xl font-semibold text-primary font-mono select-none"
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
          class="bg-background border-input text-foreground placeholder:text-muted-foreground font-mono focus-visible:ring-ring text-center w-full max-w-50"
        />
      </div>
    </div>

    {#if isMobile}
      <Button
        variant="outline"
        class="w-full font-mono text-muted-foreground"
        onclick={handleLockLogout}
      >
        <LogOut class="w-4 h-4 mr-2" />
        Lock / Logout
      </Button>
    {/if}
  </div>
{/snippet}

{#snippet AudioSection()}
  <div class="flex flex-col gap-6 mb-4">
    <div class="flex flex-col gap-4">
      <Label
        class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
        >Microphone</Label
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
            <span class="block truncate">
              {inputDevices.find((d) => d.deviceId === activeInput)?.label ||
                "Default"}
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
    </div>

    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <Label
          class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
          >Input</Label
        >
        <span class="text-xs font-mono tabular-nums"
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
    </div>

    <Separator class="bg-border" />

    <div class="flex flex-col gap-4">
      <Label
        class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
        >Speakers</Label
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
            <span class="block truncate">
              {outputDevices.find((d) => d.deviceId === activeOutput)?.label ||
                "Default"}
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
    </div>

    <div class="flex flex-col gap-2">
      <div class="flex items-center justify-between">
        <Label
          class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
          >Output</Label
        >
        <span class="text-xs font-mono tabular-nums"
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
{/snippet}

{#snippet SessionSection()}
  <div class="flex flex-col gap-6">
    <div class="flex flex-col gap-4">
      <Label
        class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
        >Session</Label
      >
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

      <label
        class="flex items-center gap-2 text-xs text-muted-foreground font-mono cursor-pointer"
      >
        <input
          type="checkbox"
          bind:checked={rememberResetTimer}
          onchange={() => {
            localStorage.setItem(
              "awful_remember_reset_timer",
              String(rememberResetTimer)
            );
          }}
          class="accent-primary"
        />
        Reset timer on login
      </label>
    </div>

    {#if canEnrollBiometrics || identityStore.hasWebAuthn}
      <Separator class="bg-border" />
      <div class="flex flex-col gap-4">
        <Label
          class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
          >Security</Label
        >

        {#if identityStore.hasWebAuthn}
          <p class="text-xs text-muted-foreground font-mono">
            Biometric unlock is enabled
          </p>
          {#if !confirmRemoveBiometric}
            <Button
              variant="outline"
              class="w-full font-mono text-xs"
              onclick={() => (confirmRemoveBiometric = true)}
            >
              Remove biometric
            </Button>
          {:else}
            <div class="flex gap-2">
              <Button
                variant="outline"
                class="flex-1 font-mono text-xs"
                onclick={() => (confirmRemoveBiometric = false)}
              >
                Cancel
              </Button>
              <Button
                variant="destructive"
                class="flex-1 font-mono text-xs"
                onclick={async () => {
                  await removeWebAuthn();
                  confirmRemoveBiometric = false;
                }}
              >
                Remove
              </Button>
            </div>
          {/if}
        {:else}
          <p class="text-xs text-muted-foreground font-mono">
            Use biometrics to unlock without password
          </p>
          <Input
            type="password"
            bind:value={biometricPassword}
            placeholder="Password to enroll"
            class="bg-background border-input font-mono focus-visible:ring-ring text-sm {biometricError
              ? 'border-destructive'
              : ''}"
          />
          {#if biometricError}
            <p class="text-xs text-destructive font-mono">{biometricError}</p>
          {/if}
          {#if biometricSuccess}
            <p class="text-xs text-green-500 font-mono">
              Biometric unlock enabled
            </p>
          {/if}
          <Button
            variant="outline"
            class="w-full font-mono text-xs"
            disabled={biometricPassword.length === 0 || biometricLoading}
            onclick={async () => {
              biometricError = null;
              biometricSuccess = false;
              biometricLoading = true;
              try {
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
            {biometricLoading ? "Please wait..." : "Enable biometric unlock"}
          </Button>
        {/if}
      </div>
    {/if}

    <Separator class="bg-border" />

    <div class="flex flex-col gap-4">
      <Label
        class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
        >Sync</Label
      >
      <div class="grid grid-cols-2 gap-2">
        <Button
          variant="outline"
          class="font-mono flex-col h-auto py-3 gap-2"
          onclick={() => {
            syncDialogMode = "generate-qr";
            syncDialogOpen = true;
          }}
        >
          <QrCode class="w-5 h-5" />
          <span class="text-xs">Generate QR</span>
        </Button>
        <Button
          variant="outline"
          class="font-mono flex-col h-auto py-3 gap-2"
          onclick={() => {
            syncDialogMode = "scan-qr";
            syncDialogOpen = true;
          }}
        >
          <Camera class="w-5 h-5" />
          <span class="text-xs">Scan QR</span>
        </Button>
      </div>
    </div>
  </div>
{/snippet}

{#snippet DataSection()}
  <div class="flex flex-col gap-6">
    <!-- Metrics Dashboard -->
    {#if metrics}
      <div class="flex flex-col gap-4">
        <Label
          class="text-xs font-mono text-muted-foreground uppercase tracking-wider"
          >Storage Metrics</Label
        >

        <!-- Stats Grid -->
        <div class="grid grid-cols-2 gap-3">
          <div class="bg-muted/50 rounded-lg p-3">
            <div class="flex items-center gap-2 mb-1">
              <MessageSquare class="w-3.5 h-3.5 text-muted-foreground" />
              <span
                class="text-[10px] text-muted-foreground font-mono uppercase"
                >Messages</span
              >
            </div>
            <p class="text-lg font-semibold font-mono">
              {metrics.totalMessages.toLocaleString()}
            </p>
          </div>
          <div class="bg-muted/50 rounded-lg p-3">
            <div class="flex items-center gap-2 mb-1">
              <Users class="w-3.5 h-3.5 text-muted-foreground" />
              <span
                class="text-[10px] text-muted-foreground font-mono uppercase"
                >Rooms</span
              >
            </div>
            <p class="text-lg font-semibold font-mono">
              {metrics.totalRooms.toLocaleString()}
            </p>
          </div>
          <div class="bg-muted/50 rounded-lg p-3">
            <div class="flex items-center gap-2 mb-1">
              <Users class="w-3.5 h-3.5 text-muted-foreground" />
              <span
                class="text-[10px] text-muted-foreground font-mono uppercase"
                >Profiles</span
              >
            </div>
            <p class="text-lg font-semibold font-mono">
              {metrics.totalProfiles.toLocaleString()}
            </p>
          </div>
          <div class="bg-muted/50 rounded-lg p-3">
            <div class="flex items-center gap-2 mb-1">
              <File class="w-3.5 h-3.5 text-muted-foreground" />
              <span
                class="text-[10px] text-muted-foreground font-mono uppercase"
                >Files</span
              >
            </div>
            <p class="text-lg font-semibold font-mono">
              {metrics.totalAttachments.toLocaleString()}
            </p>
          </div>
        </div>

        <!-- Storage Size Card -->
        <div class="bg-muted/50 rounded-lg p-4">
          <div class="flex items-center justify-between mb-3">
            <div class="flex items-center gap-2">
              <HardDrive class="w-4 h-4 text-muted-foreground" />
              <span class="text-xs text-muted-foreground font-mono uppercase"
                >Total Storage</span
              >
            </div>
            <span class="text-lg font-semibold font-mono"
              >{formatBytes(metrics.storedDataSize)}</span
            >
          </div>

          <!-- Seeding progress -->
          {#if metrics.totalAttachments > 0}
            <div class="space-y-2">
              <div class="flex items-center justify-between text-xs">
                <span class="text-muted-foreground font-mono"
                  >Seeding {metrics.seedingAttachments} of {metrics.totalAttachments}
                  files</span
                >
                <span class="font-mono text-green-500"
                  >{Math.round(
                    (metrics.seedingAttachments / metrics.totalAttachments) *
                      100
                  )}%</span
                >
              </div>
              <div class="h-2 bg-muted rounded-full overflow-hidden">
                <div
                  class="h-full bg-linear-to-r from-green-500 to-green-400 rounded-full transition-all duration-500"
                  style="width: {(metrics.seedingAttachments /
                    metrics.totalAttachments) *
                    100}%"
                ></div>
              </div>
            </div>
          {:else}
            <p class="text-xs text-muted-foreground font-mono">
              No attachments stored
            </p>
          {/if}
        </div>

        <!-- Top Rooms Bar Chart -->
        {#if metrics.rooms.length > 0}
          <div class="bg-muted/50 rounded-lg p-4">
            <div class="flex items-center gap-2 mb-3">
              <Database class="w-4 h-4 text-muted-foreground" />
              <span class="text-xs text-muted-foreground font-mono uppercase"
                >Top Rooms</span
              >
            </div>
            <div class="flex flex-col gap-2">
              {#each metrics.rooms as room, i}
                {@const maxMessages = metrics.rooms[0]?.messageCount || 1}
                <div class="flex items-center gap-2 text-xs">
                  <span class="font-mono w-4 text-muted-foreground"
                    >{i + 1}.</span
                  >
                  <span class="font-mono w-24 truncate text-muted-foreground"
                    >{room.name}</span
                  >
                  <div class="flex-1 h-2 bg-muted rounded overflow-hidden">
                    <div
                      class="h-full bg-primary/60 rounded transition-all duration-500"
                      style="width: {(room.messageCount / maxMessages) * 100}%"
                    ></div>
                  </div>
                  <span class="font-mono w-10 text-right"
                    >{room.messageCount}</span
                  >
                </div>
              {/each}
            </div>
          </div>
        {/if}
      </div>

      <Separator class="bg-border" />
    {:else if activeTab === "data"}
      <div class="flex items-center justify-center py-8">
        <div class="flex flex-col items-center gap-2">
          <Database class="w-8 h-8 text-muted-foreground animate-pulse" />
          <span class="text-xs text-muted-foreground font-mono"
            >Loading metrics...</span
          >
        </div>
      </div>
      <Separator class="bg-border" />
    {/if}

    <!-- Danger Zone -->
    <div class="flex flex-col gap-2">
      <Label class="text-xs font-mono text-destructive uppercase tracking-wider"
        >Danger Zone</Label
      >
      <p class="text-xs text-muted-foreground font-mono">
        Erase all local data including identity, messages, and media.
      </p>
      {#if !confirmErase}
        <Button
          variant="destructive"
          class="w-full font-mono text-xs"
          onclick={() => (confirmErase = true)}
        >
          Erase all data
        </Button>
      {:else}
        <div class="flex gap-2">
          <Button
            variant="outline"
            class="flex-1 font-mono text-xs"
            onclick={() => (confirmErase = false)}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            class="flex-1 font-mono text-xs"
            onclick={handleEraseLocalData}
          >
            Confirm
          </Button>
        </div>
      {/if}
    </div>
  </div>
{/snippet}

{#snippet DesktopSidebar()}
  <div class="flex flex-col h-full">
    <div class="flex-1">
      {@render TabBar()}
    </div>
    <div class="pt-2 border-t border-border mt-2">
      <Button
        variant="ghost"
        class="w-full font-mono text-xs text-muted-foreground justify-start"
        onclick={handleLockLogout}
      >
        <LogOut class="w-4 h-4 mr-2" />
        Lock / Logout
      </Button>
    </div>
  </div>
{/snippet}

{#snippet DesktopContent()}
  <div class="flex flex-row h-full gap-8">
    <div class="hidden sm:flex w-36 h-full">
      {@render DesktopSidebar()}
    </div>
    <div class="flex-1 overflow-y-auto pr-2 pt-4">
      {#if activeTab === "profile"}
        {@render ProfileSection()}
      {:else if activeTab === "audio"}
        {@render AudioSection()}
      {:else if activeTab === "session"}
        {@render SessionSection()}
      {:else if activeTab === "data"}
        {@render DataSection()}
      {/if}
    </div>
  </div>
{/snippet}

{#if isMobile}
  <Drawer bind:open onOpenChange={closeHandler} direction="bottom">
    <DrawerContent class="bg-card text-card-foreground border-border h-3/4">
      <DrawerHeader class="px-4 py-3 border-b border-border">
        <DrawerTitle class="font-mono text-base font-semibold"
          >Settings</DrawerTitle
        >
      </DrawerHeader>
      <div class="p-4 space-y-4 border-border">
        {@render TabBar()}
        <div class="pt-2">
          {#if activeTab === "profile"}
            {@render ProfileSection()}
          {:else if activeTab === "audio"}
            {@render AudioSection()}
          {:else if activeTab === "session"}
            {@render SessionSection()}
          {:else if activeTab === "data"}
            {@render DataSection()}
          {/if}
        </div>
      </div>
    </DrawerContent>
  </Drawer>
{:else}
  <Dialog bind:open onOpenChange={closeHandler}>
    <DialogContent
      class="bg-card border-border text-card-foreground font-mono w-full sm:max-w-lg lg:max-w-5xl min-h-200 sm:h-137.5 lg:h-150 flex flex-col p-0"
    >
      <DialogHeader class="px-6 py-4 border-b border-border shrink-0">
        <DialogTitle class="font-mono text-base font-semibold"
          >Settings</DialogTitle
        >
      </DialogHeader>
      <div class="flex-1 overflow-hidden px-4 pb-4">
        {@render DesktopContent()}
      </div>
    </DialogContent>
  </Dialog>
{/if}

<AvatarPickerDialog
  open={avatarDialogOpen}
  onClose={() => {
    avatarDialogOpen = false;
  }}
/>

<DeviceSyncDialog
  bind:open={syncDialogOpen}
  onClose={() => {
    syncDialogOpen = false;
  }}
  flowMode={syncDialogMode}
/>
