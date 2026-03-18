<script lang="ts">
  import {
    Camera,
    CameraOff,
    Headphones,
    HeadphoneOff,
    Mic,
    MicOff,
    Monitor,
    MonitorOff,
    PhoneOff,
    Settings,
  } from "@lucide/svelte";
  import {
    transportState,
    toggleMute,
    toggleDeafen,
    toggleCamera,
    startScreenShare,
    stopScreenShare,
    leaveCall,
  } from "$lib/transport.svelte";
  import { profileStore, loadProfile } from "$lib/profile.svelte";
  import AvatarPickerDialog from "$lib/components/AvatarPickerDialog.svelte";
  import SettingsDialog from "$lib/components/SettingsDialog.svelte";

  let avatarDialogOpen = $state(false);
  let audioSettingsOpen = $state(false);

  $effect(() => {
    loadProfile();
  });

  const initial = $derived(
    (profileStore.nickname || "?").charAt(0).toUpperCase()
  );
</script>

<div class="shrink-0 flex flex-col bg-card border-t border-sidebar-border">
  <!-- In-call media row -->
  {#if transportState.inCall}
    <div
      class="flex items-center justify-stretch gap-1 px-2 py-2 border-b border-sidebar-border"
    >
      <button
        type="button"
        onclick={toggleCamera}
        aria-label={transportState.cameraOff
          ? "Turn on camera"
          : "Turn off camera"}
        class="flex flex-1 items-center justify-center rounded-md h-9 cursor-pointer transition-colors
          {transportState.cameraOff
          ? 'bg-secondary text-secondary-foreground hover:bg-secondary/80'
          : 'bg-destructive/20 text-destructive hover:bg-destructive/30'}"
      >
        {#if transportState.cameraOff}
          <Camera class="size-4" />
        {:else}
          <CameraOff class="size-4" />
        {/if}
      </button>

      <button
        type="button"
        onclick={transportState.screenSharing
          ? stopScreenShare
          : startScreenShare}
        aria-label={transportState.screenSharing
          ? "Stop screen share"
          : "Share screen"}
        class="flex flex-1 items-center justify-center rounded-md h-9 cursor-pointer transition-colors
          {transportState.screenSharing
          ? 'bg-destructive/20 text-destructive hover:bg-destructive/30'
          : 'bg-secondary text-secondary-foreground hover:bg-secondary/80'}"
      >
        {#if transportState.screenSharing}
          <MonitorOff class="size-4" />
        {:else}
          <Monitor class="size-4" />
        {/if}
      </button>

      <button
        type="button"
        onclick={leaveCall}
        aria-label="Leave call"
        class="flex flex-1 items-center justify-center rounded-md h-9 cursor-pointer transition-colors bg-destructive/20 text-destructive hover:bg-destructive/30"
      >
        <PhoneOff class="size-4" />
      </button>
    </div>
  {/if}

  <div class="flex gap-2 px-2 py-4.25 w-full justify-between">
    <div class="flex items-center gap-2">
      <div class="relative">
        <button
          type="button"
          onclick={() => {
            avatarDialogOpen = true;
          }}
          aria-label="Change profile picture"
          class="relative flex size-9 items-center justify-center rounded-full overflow-hidden bg-primary/20 hover:ring-2 hover:ring-primary/50 transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary"
        >
          {#if profileStore.avatarUrl}
            <img
              src={profileStore.avatarUrl}
              alt="Avatar"
              class="size-full object-cover"
            />
          {:else}
            <span
              class="text-sm font-semibold text-primary font-mono select-none"
              >{initial}</span
            >
          {/if}
        </button>
        <div
          class="absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-card
          {transportState.connected ? 'bg-primary' : 'bg-yellow-500'}"
        ></div>
      </div>

      <!-- Name + status -->
      <div class="flex flex-col gap-1.5 mt-1 w-full">
        <div
          class="truncate w-26 text-xs font-semibold text-foreground font-mono leading-tight"
        >
          {profileStore.nickname}
        </div>
        <div class="text-xs text-muted-foreground font-mono leading-tight">
          {transportState.connected ? "Connected" : "Connecting..."}
        </div>
      </div>
    </div>

    <!-- Mic, Deafen, Settings -->
    <div class="flex items-center gap-0.5 justify-end">
      <button
        type="button"
        onclick={toggleMute}
        aria-label={transportState.muted ? "Unmute" : "Mute"}
        class="flex items-center justify-center rounded-md size-8 cursor-pointer transition-colors
          {transportState.muted
          ? 'bg-destructive/20 text-destructive hover:bg-destructive/30'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted'}"
      >
        {#if transportState.muted}
          <MicOff class="size-4" />
        {:else}
          <Mic class="size-4" />
        {/if}
      </button>

      <button
        type="button"
        onclick={toggleDeafen}
        aria-label={transportState.deafened ? "Undeafen" : "Deafen"}
        class="flex items-center justify-center rounded-md size-8 cursor-pointer transition-colors
          {transportState.deafened
          ? 'bg-destructive/20 text-destructive hover:bg-destructive/30'
          : 'text-muted-foreground hover:text-foreground hover:bg-muted'}"
      >
        {#if transportState.deafened}
          <HeadphoneOff class="size-4" />
        {:else}
          <Headphones class="size-4" />
        {/if}
      </button>

      <button
        type="button"
        onclick={() => (audioSettingsOpen = true)}
        aria-label="Settings"
        class="flex items-center justify-center rounded-md size-8 cursor-pointer transition-colors text-muted-foreground hover:text-foreground hover:bg-muted"
      >
        <Settings class="size-4" />
      </button>
    </div>
  </div>
</div>

<AvatarPickerDialog
  open={avatarDialogOpen}
  onClose={() => {
    avatarDialogOpen = false;
  }}
/>

<SettingsDialog
  bind:open={audioSettingsOpen}
  onClose={() => {
    audioSettingsOpen = false;
  }}
/>
