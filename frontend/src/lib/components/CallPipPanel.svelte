<script lang="ts">
  import {
    CornerUpLeft,
    Mic,
    MicOff,
    PhoneOff,
    PictureInPicture2,
    Video,
    VideoOff,
    X,
  } from "@lucide/svelte";
  import { Tip } from "$lib/components/ui/tooltip";
  import { draggable } from "$lib/actions/draggable";
  import {
    BAR_HEIGHT,
    panelHeight,
    panelWidth,
    callPipPanel,
    defaultPanelPosition,
    clampPanelToViewport,
  } from "$lib/call-pip.svelte";
  import { toggleMute, cameraOnPressed, leaveCall } from "$lib/transport/call.svelte";
  import { requestReturnToCall } from "$lib/ui-state.svelte";
  import { transportState, peerIdToDid } from "$lib/transport/transport.svelte";
  import { roomsStore } from "$lib/rooms.svelte";
  import { displayPrefs } from "$lib/display-prefs.svelte";
  import { speakers } from "$lib/speakers.svelte";
  import {
    spotlightStore,
    getSpeakingLabel,
    browserPipSupported,
    enterBrowserPip,
    exitBrowserPip,
  } from "$lib/call-spotlight.svelte";

  // Read the shared spotlight from AppView.
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

  function togglePip(): void {
    if (callPipPanel.browserPip) void exitBrowserPip();
    else void enterBrowserPip(() => void requestReturnToCall());
  }

  // panelWidth reads window.innerWidth, which is not reactive; bump this on
  // resize so the derived width recomputes.
  let viewportTick = $state(0);
  function clampToViewport(): void {
    viewportTick++;
    clampPanelToViewport(hasVideo);
  }

  // Initialize position on first mount
  $effect(() => {
    if (callPipPanel.x === 0 && callPipPanel.y === 0) {
      Object.assign(callPipPanel, defaultPanelPosition());
    }
  });

  // A close lasts for this visit away from the call: going back to the call's
  // room, or the call ending, brings the panel back next time.
  $effect(() => {
    if (
      !transportState.inCall ||
      transportState.uiRoomCode === transportState.callRoomCode
    ) {
      callPipPanel.dismissed = false;
    }
  });

  const isSpeaking = $derived(
    spotlightTile && speakers.speaking.has(spotlightTile.peerId)
  );

  // Voice-only call: nothing worth a video body, so the panel is its bar.
  const hasVideo = $derived(!!spotlightTile?.videoTrack);
  const height = $derived(panelHeight(hasVideo));
  const width = $derived.by(() => {
    void viewportTick;
    return panelWidth();
  });

  const btn =
    "inline-flex size-8 [@media(pointer:coarse)]:size-10 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground";
</script>

<svelte:window onresize={clampToViewport} />


{#if displayPrefs.callPip && transportState.inCall && transportState.uiRoomCode !== transportState.callRoomCode && !callPipPanel.dismissed}
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
      class="flex shrink-0 cursor-grab touch-none items-center gap-1.5 border-b border-border bg-muted/40 pl-2.5 pr-1.5 active:cursor-grabbing"
      style="height: {BAR_HEIGHT}px"
    >
      <!-- One row: the room (the drag handle), then the controls. -->
      <span class="flex min-w-0 flex-1 items-center gap-1.5 text-xs font-medium">
        <span
          class="size-2 shrink-0 rounded-full {isSpeaking
            ? 'animate-pulse bg-primary'
            : 'bg-green-500'}"
        ></span>
        <span class="truncate">{panelRoomName}</span>
      </span>

      <Tip text={transportState.muted ? "Unmute" : "Mute"}>
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={() => void toggleMute()}
            aria-label={transportState.muted ? "Unmute" : "Mute"}
            class="{btn} {transportState.muted ? 'text-red-400' : ''}"
          >
            {#if transportState.muted}
              <MicOff class="size-4" />
            {:else}
              <Mic class="size-4" />
            {/if}
          </button>
        {/snippet}
      </Tip>

      <Tip text={transportState.cameraOff ? "Start camera" : "Stop camera"}>
          {#snippet children(props)}
            <button
              {...props}
              type="button"
              onclick={cameraOnPressed}
              disabled={transportState.cameraPending}
              aria-busy={transportState.cameraPending}
              aria-label={transportState.cameraOff ? "Start camera" : "Stop camera"}
              class="{btn} disabled:cursor-wait disabled:opacity-50 {transportState.cameraPending ? 'animate-pulse' : ''}"
            >
              {#if transportState.cameraOff}
                <VideoOff class="size-4" />
              {:else}
                <Video class="size-4" />
              {/if}
            </button>
          {/snippet}
        </Tip>

        <!-- Only with a picture to float: a voice-only call has nothing to put
             in a browser picture-in-picture window. -->
        {#if hasVideo && browserPipSupported()}
          <Tip text={callPipPanel.browserPip ? "Exit picture-in-picture" : "Picture-in-picture"}>
            {#snippet children(props)}
              <button
                {...props}
                type="button"
                onclick={togglePip}
                aria-label={callPipPanel.browserPip ? "Exit picture-in-picture" : "Picture-in-picture"}
                class="{btn} {callPipPanel.browserPip ? 'text-primary' : ''}"
              >
                <PictureInPicture2 class="size-4" />
              </button>
            {/snippet}
          </Tip>
        {/if}

        <Tip text="Back to call">
          {#snippet children(props)}
            <button
              {...props}
              type="button"
              onclick={() => void requestReturnToCall()}
              aria-label="Back to call"
              class={btn}
            >
              <CornerUpLeft class="size-4" />
            </button>
          {/snippet}
        </Tip>

        <Tip text="Leave call">
          {#snippet children(props)}
            <button
              {...props}
              type="button"
              onclick={() => leaveCall()}
              aria-label="Leave call"
              class="{btn} bg-red-600 text-white hover:bg-red-700 hover:text-white"
            >
              <PhoneOff class="size-4" />
            </button>
          {/snippet}
        </Tip>

      <!-- Hides the panel for this call; the call itself carries on. -->
      <Tip text="Close">
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={() => (callPipPanel.dismissed = true)}
            aria-label="Close call panel"
            class={btn}
          >
            <X class="size-4" />
          </button>
        {/snippet}
      </Tip>
    </div>

    <!-- Panel body: shows the spotlight tile video -->
    {#if hasVideo && spotlightTile}
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
          class="absolute inset-0 w-full h-full object-contain bg-black"
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
