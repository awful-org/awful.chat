<script lang="ts">
  import { Maximize2, Minus, Phone, PhoneOff, Mic, MicOff, Video, VideoOff, Pin } from "@lucide/svelte";
  import { Tip } from "$lib/components/ui/tooltip";
  import { draggable } from "$lib/actions/draggable";
  import {
    BAR_HEIGHT,
    HEIGHT,
    panelWidth,
    callPipPanel,
    defaultPanelPosition,
    clampPanelToViewport,
  } from "$lib/call-pip.svelte";
  import { toggleMute, toggleCamera, leaveCall } from "$lib/transport/call.svelte";
  import { requestReturnToCall } from "$lib/ui-state.svelte";
  import { transportState, peerIdToDid } from "$lib/transport/transport.svelte";
  import { roomsStore } from "$lib/rooms.svelte";
  import { displayPrefs } from "$lib/display-prefs.svelte";
  import { speakers } from "$lib/speakers.svelte";
  import { callFocus } from "$lib/call-focus.svelte";
  import {
    spotlightStore,
    getSpeakingLabel,
    enterBrowserPip,
    exitBrowserPip,
  } from "$lib/call-spotlight.svelte";
  import type { SpotlightTile } from "$lib/spotlight";

  // Read the shared spotlight from AppView.
  const tiles = $derived(spotlightStore.tiles);
  const spotlightTileId = $derived(spotlightStore.spotlightTileId);
  const spotlightTile = $derived(spotlightStore.spotlightTile);

  function handlePipVideoClick(): void {
    void requestReturnToCall();
  }

  // The CALL's room, not the one on screen (that is the whole reason the
  // panel is showing). A DM room code is a hash of the two DIDs, so the
  // counterparty comes from the stored DM room, the same way returnToCall
  // finds it.
  const panelRoomName = $derived.by(() => {
    const code = transportState.callRoomCode;
    if (!code) return "Call";
    if (code.startsWith("dm-")) {
      const did = roomsStore.dmRooms.find((r) => r.roomCode === code)
        ?.participantDid;
      return (did && transportState.peerNames.get(did)) || "Direct message";
    }
    return roomsStore.rooms.find((r) => r.roomCode === code)?.name || code.slice(0, 12);
  });

  // Handle pin cycling: pin current -> unpin
  function togglePin(): void {
    if (callFocus.pinnedTileId === spotlightTileId) {
      callFocus.pinnedTileId = null;
    } else if (spotlightTileId) {
      callFocus.pinnedTileId = spotlightTileId;
    }
  }

  async function enterPip(): Promise<void> {
    await enterBrowserPip(() => void requestReturnToCall());
  }
  async function exitPip(): Promise<void> {
    await exitBrowserPip();
  }

  // Clamping on window resize
  function clampToViewport(): void {
    clampPanelToViewport();
  }

  // Initialize position on first mount
  $effect(() => {
    if (callPipPanel.x === 0 && callPipPanel.y === 0) {
      Object.assign(callPipPanel, defaultPanelPosition());
    }
  });

  // Get the speaking ring display for the minimized state
  const isSpeaking = $derived(
    spotlightTile && speakers.speaking.has(spotlightTile.peerId)
  );

  // Voice-only call: nothing worth a video body, so the panel is its bar.
  const hasVideo = $derived(!!spotlightTile?.videoTrack);
  const height = $derived(
    callPipPanel.minimized || !hasVideo ? BAR_HEIGHT : HEIGHT + BAR_HEIGHT
  );
  const width = $derived(panelWidth());

</script>

<svelte:window onresize={clampToViewport} />


{#if displayPrefs.callPip && transportState.inCall && transportState.uiRoomCode !== transportState.callRoomCode}
  <!--
    z-50 is the app's chrome layer, shared with context menus and dialogs.
    The panel floats over the call without stealing focus the way a modal would.
  -->
  <div
    class="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-card shadow-2xl"
    style="left: {callPipPanel.x}px; top: {callPipPanel.y}px; width: {width}px; height: {height}px;"
  >
    <!-- Title bar: draggable, contains controls -->
    <div
      use:draggable={{
        get: () => ({ x: callPipPanel.x, y: callPipPanel.y }),
        set: (pos) => {
          callPipPanel.x = pos.x;
          callPipPanel.y = pos.y;
        },
        size: () => ({ width, height }),
      }}
      class="flex h-9 shrink-0 cursor-grab touch-none items-center gap-1 border-b border-border bg-muted/40 px-2 active:cursor-grabbing"
    >
      <!-- Room name with speaking ring if minimized -->
      <span class="min-w-0 flex-1 truncate text-xs font-medium">
        {panelRoomName}
        {#if (callPipPanel.minimized || !hasVideo) && isSpeaking}
          <span class="ml-1 inline-block size-2 animate-pulse rounded-full bg-primary"></span>
        {/if}
      </span>

      <!-- Mute button -->
      <Tip text={transportState.muted ? "Unmute" : "Mute"}>
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={() => void toggleMute()}
            aria-label={transportState.muted ? "Unmute" : "Mute"}
            class="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {#if transportState.muted}
              <MicOff class="size-3.5" />
            {:else}
              <Mic class="size-3.5" />
            {/if}
          </button>
        {/snippet}
      </Tip>

      <!-- Camera button -->
      <Tip text={transportState.cameraOff ? "Start camera" : "Stop camera"}>
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={() => void toggleCamera()}
            aria-label={transportState.cameraOff ? "Start camera" : "Stop camera"}
            class="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {#if transportState.cameraOff}
              <VideoOff class="size-3.5" />
            {:else}
              <Video class="size-3.5" />
            {/if}
          </button>
        {/snippet}
      </Tip>

      <!-- Pin button -->
      <Tip text={callFocus.pinnedTileId === spotlightTileId ? "Unpin" : "Pin"}>
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={togglePin}
            aria-label={callFocus.pinnedTileId === spotlightTileId ? "Unpin" : "Pin"}
            class="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Pin class="size-3.5" />
          </button>
        {/snippet}
      </Tip>

      <!-- Browser PiP button -->
      <Tip text={callPipPanel.browserPip ? "Exit PiP" : "Picture in Picture"}>
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={() => {
              if (callPipPanel.browserPip) {
                void exitPip();
              } else {
                void enterPip();
              }
            }}
            aria-label={callPipPanel.browserPip ? "Exit PiP" : "Picture in Picture"}
            class="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Maximize2 class="size-3.5" />
          </button>
        {/snippet}
      </Tip>

      <!-- Minimize button -->
      <Tip text={callPipPanel.minimized ? "Expand panel" : "Collapse to the bar"}>
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={() => (callPipPanel.minimized = !callPipPanel.minimized)}
            aria-label={callPipPanel.minimized ? "Restore panel" : "Minimize panel"}
            class="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Minus class="size-3.5" />
          </button>
        {/snippet}
      </Tip>

      <!-- Back to call button -->
      <Tip text="Back to call">
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={() => void requestReturnToCall()}
            aria-label="Back to call"
            class="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <Phone class="size-3.5" />
          </button>
        {/snippet}
      </Tip>

      <!-- Leave call button -->
      <Tip text="Leave call">
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={() => leaveCall()}
            aria-label="Leave call"
            class="inline-flex size-6 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            <PhoneOff class="size-3.5" />
          </button>
        {/snippet}
      </Tip>
    </div>

    <!-- Panel body: shows the spotlight tile video -->
    {#if !callPipPanel.minimized && hasVideo && spotlightTile}
      <button
        type="button"
        class="relative flex-1 overflow-hidden bg-black cursor-pointer"
        onclick={handlePipVideoClick}
        aria-label="Click to return to call"
      >
        <!-- Video element for in-app display. AppView's $effect updates its
             srcObject to match the spotlight, along with the PiP video.
             This way a single spotlight change swaps srcObject on both. -->
        <video
          class="absolute inset-0 w-full h-full"
          autoplay
          muted
          playsinline
          style="object-fit: {spotlightTile.kind === 'screen' || spotlightTile.kind === 'transmission' ? 'contain' : 'cover'}"
          bind:this={spotlightStore.panelVideoElement}
        ></video>

        <!-- Label and speaking/sharing tag overlay (bottom-left) -->
        <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/80 to-transparent px-2 py-2">
          <div class="flex items-center justify-between gap-2">
            <span class="text-xs font-medium text-white truncate">
              {transportState.peerNames.get(peerIdToDid(spotlightTile.peerId) || spotlightTile.peerId) ||
                transportState.peerNames.get(spotlightTile.peerId) ||
                spotlightTile.peerId.slice(0, 8)}
            </span>
            {#if getSpeakingLabel(spotlightTile, speakers)}
              <span class="text-xs text-gray-300 shrink-0">
                {getSpeakingLabel(spotlightTile, speakers)}
              </span>
            {/if}
          </div>
        </div>
      </button>
    {/if}
  </div>
{/if}
