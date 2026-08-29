<script lang="ts">
  import { uiState } from "$lib/ui-state.svelte";
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
  import { transportState } from "$lib/transport/transport.svelte";
  import {
    toggleMute,
    toggleCamera,
    startScreenShare,
    stopScreenShare,
    leaveCall,
  } from "$lib/transport/call.svelte";
  import { profileStore, loadProfile } from "$lib/profile.svelte";
  import { displayPrefs } from "$lib/display-prefs.svelte";
  import AvatarPickerDialog from "$lib/components/AvatarPickerDialog.svelte";
  import SettingsDialog from "$lib/components/SettingsDialog.svelte";
  import { Tip } from "$lib/components/ui/tooltip";
  import DeviceSyncDialog from "$lib/components/DeviceSyncDialog.svelte";
  import { toggleDeafen } from "$lib/transport/call.svelte";

  interface Props {
    /** Icon-rail layout: no name, no status text, controls stacked. */
    collapsed?: boolean;
  }
  let { collapsed = false }: Props = $props();

  // In a column the buttons must grow across, not along, the axis.
  const mediaBtnWidth = $derived(collapsed ? "w-full" : "flex-1");

  let avatarDialogOpen = $state(false);
  let audioSettingsOpen = $state(false);

  // Open-settings requests from elsewhere (profile card edit button).
  $effect(() => {
    if (uiState.settingsOpenRequested) {
      uiState.settingsOpenRequested = false;
      audioSettingsOpen = true;
    }
  });
  // Owned here (not in SettingsDialog) so the sync dialog survives the settings
  // dialog closing on mobile - see SessionSettings onOpenSync.
  let syncDialogOpen = $state(false);
  let syncFlowMode = $state<"receive" | "generate-qr" | "scan-qr">("receive");

  $effect(() => {
    loadProfile();
  });

  // Manifest shortcut: long-press the installed icon > "Pair a device".
  $effect(() => {
    const params = new URLSearchParams(window.location.search);
    if (params.get("sync") !== "1") return;
    syncFlowMode = "generate-qr";
    syncDialogOpen = true;
    params.delete("sync");
    const query = params.toString();
    history.replaceState(
      {},
      "",
      window.location.pathname + (query ? `?${query}` : "")
    );
  });

  const initial = $derived(
    (profileStore.nickname || "?").charAt(0).toUpperCase()
  );
</script>

<div class="shrink-0 flex flex-col bg-card border-t border-sidebar-border">
  <!-- In-call media row -->
  {#if transportState.inCall}
    <div
      class="flex px-2 py-2 border-b border-sidebar-border {collapsed
        ? 'flex-col gap-1'
        : 'items-center justify-stretch gap-1'}"
    >
      <Tip
        text={transportState.cameraOff ? "Turn on camera" : "Turn off camera"}
      >
        {#snippet children(props)}
      <button
        {...props}
        type="button"
        onclick={toggleCamera}
        aria-label={transportState.cameraOff
          ? "Turn on camera"
          : "Turn off camera"}
        class="flex {mediaBtnWidth} items-center justify-center rounded-md h-9 cursor-pointer transition-colors
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
        {/snippet}
      </Tip>

      <Tip
        text={transportState.screenSharing
          ? "Stop screen share"
          : "Share screen"}
      >
        {#snippet children(props)}
      <button
        {...props}
        type="button"
        onclick={transportState.screenSharing
          ? stopScreenShare
          : startScreenShare}
        aria-label={transportState.screenSharing
          ? "Stop screen share"
          : "Share screen"}
        class="flex {mediaBtnWidth} items-center justify-center rounded-md h-9 cursor-pointer transition-colors
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
        {/snippet}
      </Tip>

      <Tip text="Leave call">
        {#snippet children(props)}
      <button
        {...props}
        type="button"
        onclick={leaveCall}
        aria-label="Leave call"
        class="flex {mediaBtnWidth} items-center justify-center rounded-md h-9 cursor-pointer transition-colors bg-destructive/20 text-destructive hover:bg-destructive/30"
      >
        <PhoneOff class="size-4" />
      </button>
        {/snippet}
      </Tip>
    </div>
  {/if}

  <div
    class="flex w-full {collapsed
      ? 'flex-col items-center gap-2 px-1 py-3'
      : 'gap-2 px-2 py-4.25 justify-between'}"
  >
    <div class="flex items-center gap-2 {collapsed ? 'flex-col' : ''}">
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
        <!-- Connection status dot: always shown, not gated on showConnectionInfo.
             That setting controls only the floating panel on the right. -->
        <div
          class="absolute -bottom-0.5 -right-0.5 size-3 rounded-full ring-2 ring-card
          {transportState.relayConnected ? 'bg-primary' : 'bg-yellow-500'}"
        ></div>
      </div>

      <!-- Name + status -->
      {#if !collapsed}
        <div class="flex flex-col gap-1.5 mt-1 w-full">
          <div
            class="truncate w-26 text-xs font-semibold text-foreground font-mono leading-tight"
          >
            {profileStore.nickname}
          </div>
          <!-- Connection status text: always shown, not gated on showConnectionInfo.
               That setting controls only the floating panel on the right. -->
          <div class="text-xs text-muted-foreground font-mono leading-tight">
            {transportState.relayConnected ? "Connected" : "Connecting..."}
          </div>
        </div>
      {/if}
    </div>

    <!-- Mic, Deafen, Settings -->
    <div
      class="flex items-center gap-0.5 {collapsed ? 'flex-col' : 'justify-end'}"
    >
      <Tip
        text={transportState.muted ? "Unmute" : "Mute"}
        side={collapsed ? "right" : "top"}
      >
        {#snippet children(props)}
      <button
        {...props}
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
        {/snippet}
      </Tip>

      <Tip
        text={transportState.deafened ? "Undeafen" : "Deafen"}
        side={collapsed ? "right" : "top"}
      >
        {#snippet children(props)}
      <button
        {...props}
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
        {/snippet}
      </Tip>

      <Tip text="Settings" side={collapsed ? "right" : "top"}>
        {#snippet children(props)}
      <button
        {...props}
        type="button"
        onclick={() => (audioSettingsOpen = true)}
        aria-label="Settings"
        class="flex items-center justify-center rounded-md size-8 cursor-pointer transition-colors text-muted-foreground hover:text-foreground hover:bg-muted"
      >
        <Settings class="size-4" />
      </button>
        {/snippet}
      </Tip>
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
  onOpenSync={(mode) => {
    syncFlowMode = mode;
    syncDialogOpen = true;
  }}
/>

<DeviceSyncDialog
  bind:open={syncDialogOpen}
  flowMode={syncFlowMode}
  onClose={() => {
    syncDialogOpen = false;
  }}
/>
