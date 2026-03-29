<script lang="ts">
  import {
    transportState,
    setTransmissionOutputVolume,
    selfId,
    peerIdToDid,
    isRelayed,
    watchTransmission,
    joinCall,
    toggleCamera,
    toggleMute,
    stopScreenShare,
    startScreenShare,
    leaveCall,
    stopWatchingTransmission,
  } from "$lib/transport.svelte";
  import {
    Mic,
    MicOff,
    Camera,
    CameraOff,
    Monitor,
    MonitorOff,
    PhoneOff,
    Phone,
    Maximize,
    Minimize,
    Radio,
    HeadphoneOff,
    Volume2,
    Volume1,
    VolumeX,
    Workflow,
  } from "@lucide/svelte";
  import { MonitorIcon } from "@lucide/svelte";
  import { profileStore, loadProfile } from "$lib/profile.svelte";
  import { cn } from "$lib/utils";
  import { Slider } from "./ui/slider";

  $effect(() => {
    loadProfile();
  });

  interface TileData {
    id: string;
    label: string;
    avatarUrl?: string | null;
    isLocal: boolean;
    kind: "camera" | "screen" | "transmission";
    videoTrack: MediaStreamTrack | null;
    audioTrack?: MediaStreamTrack | null;
    peerId: string;
    muted?: boolean;
    deafened?: boolean;
    /** True when this is a screen-share transmission tile that hasn't been joined yet. */
    isPending?: boolean;
    /** The SFU producerId — only set on pending transmission tiles. */
    producerId?: string;
  }

  let {
    peerNames,
    peerAvatars,
    transmissionOutputVolume,
    callPeerIds,
    participants,
    localCameraStream,
    localScreenStream,
    localMicStream,
    inCall,
    muted,
    deafened,
    cameraOff,
    screenSharing,
    pendingTransmissions = new Map<string, string>(),
    watchingTransmissionPeerId = null,
    callPeerStates = new Map<string, { muted: boolean; deafened: boolean }>(),
    error = null,
  } = $derived(transportState);

  function getPeerLabel(peerId: string): string {
    const did = peerIdToDid(peerId);
    return peerNames.get(did) ?? peerNames.get(peerId) ?? peerId.slice(0, 8);
  }

  function getPeerAvatar(peerId: string): string | null {
    const did = peerIdToDid(peerId);
    return peerAvatars.get(did) ?? peerAvatars.get(peerId) ?? null;
  }

  let speakingPeers = $state(new Set<string>());
  const analysers = new Map<
    string,
    {
      ctx: AudioContext;
      analyser: AnalyserNode;
      source: MediaStreamAudioSourceNode;
    }
  >();

  function startSpeakerDetection(peerId: string, track: MediaStreamTrack) {
    // If there's a stale entry for a different track, tear it down first
    const existing = analysers.get(peerId);
    if (existing) {
      // Same track — nothing to do
      if (
        analysers.get(peerId)?.source.mediaStream.getAudioTracks()[0] === track
      )
        return;
      stopSpeakerDetection(peerId);
    }
    try {
      const ctx = new AudioContext();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      source.connect(analyser);
      analysers.set(peerId, { ctx, analyser, source });
      // Resume in case the context started suspended (common for remote tracks)
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
    } catch {
      // ignore
    }
  }

  function stopSpeakerDetection(peerId: string) {
    const entry = analysers.get(peerId);
    if (!entry) return;
    entry.source.disconnect();
    entry.ctx.close().catch(() => {});
    analysers.delete(peerId);
    speakingPeers = new Set([...speakingPeers].filter((p) => p !== peerId));
  }

  let rafId: number | null = null;

  function pollSpeakers() {
    const buf = new Uint8Array(512);
    const next = new Set<string>();
    for (const [peerId, { analyser }] of analysers) {
      analyser.getByteFrequencyData(buf);
      const avg = buf.reduce((s, v) => s + v, 0) / buf.length;
      if (avg > 5) next.add(peerId);
    }
    speakingPeers = next;
    rafId = requestAnimationFrame(pollSpeakers);
  }

  $effect(() => {
    const seen = new Set<string>();
    for (const [peerId, p] of participants) {
      seen.add(peerId);
      if (p.audioTrack) startSpeakerDetection(peerId, p.audioTrack);
      else stopSpeakerDetection(peerId);
    }
    for (const peerId of analysers.keys()) {
      if (peerId !== selfId() && !seen.has(peerId)) {
        stopSpeakerDetection(peerId);
      }
    }
    if (!muted && localMicStream) {
      const track = localMicStream.getAudioTracks()[0];
      if (track) startSpeakerDetection(selfId(), track);
    } else {
      stopSpeakerDetection(selfId());
    }
    if (!rafId) rafId = requestAnimationFrame(pollSpeakers);
    return () => {
      if (rafId) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      for (const peerId of [...analysers.keys()]) {
        stopSpeakerDetection(peerId);
      }
    };
  });

  // ── Video / Audio actions ─────────────────────────────────────────────────

  function videoAction(node: HTMLVideoElement, track: MediaStreamTrack) {
    node.srcObject = new MediaStream([track]);
    node.play().catch(() => {});
    return {
      update(t: MediaStreamTrack) {
        node.srcObject = new MediaStream([t]);
        node.play().catch(() => {});
      },
      destroy() {
        node.srcObject = null;
      },
    };
  }

  function audioAction(node: HTMLAudioElement, track: MediaStreamTrack) {
    node.srcObject = new MediaStream([track]);
    node.play().catch(() => {});
    return {
      update(t: MediaStreamTrack) {
        node.srcObject = new MediaStream([t]);
        node.play().catch(() => {});
      },
      destroy() {
        node.srcObject = null;
      },
    };
  }

  // ── Tiles ─────────────────────────────────────────────────────────────────

  const localVideoTrack = $derived(
    localCameraStream?.getVideoTracks()[0] ?? null
  );
  const localScreenTrack = $derived(
    localScreenStream?.getVideoTracks()[0] ?? null
  );

  const tiles = $derived.by<TileData[]>(() => {
    const result: TileData[] = [];
    const byPeer = new Map(participants);
    result.push({
      id: "local-camera",
      label: profileStore.nickname || "You",
      avatarUrl: profileStore.avatarUrl,
      isLocal: true,
      kind: "camera",
      videoTrack: localVideoTrack,
      peerId: selfId(),
      muted,
      deafened,
    });
    for (const peerId of callPeerIds) {
      const p = byPeer.get(peerId) ?? {
        peerId,
        audioTrack: null,
        videoTrack: null,
        screenTrack: null,
        screenAudioTrack: null,
      };
      const label = getPeerLabel(peerId);
      const avatarUrl = getPeerAvatar(peerId);
      const remoteCallState = callPeerStates.get(peerId);
      result.push({
        id: `remote-camera-${peerId}`,
        label,
        avatarUrl,
        isLocal: false,
        kind: "camera",
        videoTrack: p.videoTrack,
        audioTrack: p.audioTrack,
        peerId,
        muted: remoteCallState?.muted,
        deafened: remoteCallState?.deafened,
      });
    }
    if (localScreenTrack) {
      result.push({
        id: "local-screen",
        label: profileStore.nickname || "You",
        avatarUrl: profileStore.avatarUrl,
        isLocal: true,
        kind: "screen",
        videoTrack: localScreenTrack,
        peerId: selfId(),
      });
    }
    for (const p of byPeer.values()) {
      if (p.screenTrack) {
        const label = getPeerLabel(p.peerId);
        const avatarUrl = getPeerAvatar(p.peerId);
        result.push({
          id: `remote-screen-${p.peerId}`,
          label,
          avatarUrl,
          isLocal: false,
          kind: "screen",
          videoTrack: p.screenTrack,
          peerId: p.peerId,
        });
      }
    }
    // Pending transmission tiles — remote peers sharing their screen (opt-in)
    for (const [peerId, producerId] of pendingTransmissions) {
      const label = getPeerLabel(peerId);
      const avatarUrl = getPeerAvatar(peerId);
      result.push({
        id: `pending-tx-${peerId}`,
        label,
        avatarUrl,
        isLocal: false,
        kind: "transmission",
        videoTrack: null,
        peerId,
        isPending: true,
        producerId,
      });
    }
    return result;
  });

  const hasActiveVideo = $derived(
    localVideoTrack !== null ||
      localScreenTrack !== null ||
      [...participants.values()].some((p) => p.videoTrack || p.screenTrack)
  );

  const isWatchingTransmission = $derived(watchingTransmissionPeerId !== null);

  const remoteAudio = $derived.by(() => {
    const tracks: Array<{ id: string; track: MediaStreamTrack }> = [];
    const seenTrackIds = new Set<string>();
    for (const p of participants.values()) {
      // VoiceTransport already renders/plays remote voice audio through Web Audio.
      // Only mount <audio> for screen-share audio tracks here.
      if (p.screenAudioTrack && !seenTrackIds.has(p.screenAudioTrack.id)) {
        seenTrackIds.add(p.screenAudioTrack.id);
        tracks.push({
          id: `${p.peerId}-screen-${p.screenAudioTrack.id}`,
          track: p.screenAudioTrack,
        });
      }
    }
    return tracks;
  });

  const gridCols = $derived.by(() => {
    const n = tiles.length;
    if (n <= 1) return "grid-cols-1";
    if (n <= 3) return "grid-cols-1 sm:grid-cols-2";
    if (n <= 7) return "grid-cols-2 sm:grid-cols-3";
    return "grid-cols-2 sm:grid-cols-4";
  });

  const rowClass = $derived.by(() => {
    const n = tiles.length;
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    const rows = Math.ceil(n / cols);
    return rows <= 1 ? "h-[35vh]" : "h-[45vh]";
  });

  // ── Focus ─────────────────────────────────────────────────────────────────

  let focusedTileId = $state<string | null>(null);
  const focusedTile = $derived(
    focusedTileId ? (tiles.find((t) => t.id === focusedTileId) ?? null) : null
  );
  const showThumbnails = $derived(
    focusedTile ? focusedTile.kind !== "screen" : false
  );
  const thumbnailTiles = $derived(
    focusedTile && showThumbnails
      ? tiles.filter((t) => t.id !== focusedTileId)
      : []
  );

  $effect(() => {
    if (focusedTileId && !tiles.find((t) => t.id === focusedTileId)) {
      focusedTileId = null;
    }
  });

  // ── Controls auto-hide ────────────────────────────────────────────────────

  let controlsVisible = $state(true);
  let panelEl = $state<HTMLDivElement | null>(null);
  let isFullscreen = $state(false);
  let hoveringControls = $state(false);
  let isSmallScreen = $state(false);
  let showTransmissionVolume = $state(false);
  let hideTimer: ReturnType<typeof setTimeout> | null = null;
  let adjustingTransmissionVolume = $state(false);
  let transmissionVolumeSettleTimer: ReturnType<typeof setTimeout> | null =
    null;

  // Docked only when there is nothing to watch — pure audio call
  const dockedControls = $derived(!hasActiveVideo && !isWatchingTransmission);

  $effect(() => {
    if (typeof window === "undefined") return;
    const media = window.matchMedia("(max-width: 639px)");
    const update = () => {
      isSmallScreen = media.matches;
    };
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  });

  $effect(() => {
    if (!isWatchingTransmission) showTransmissionVolume = false;
  });

  function clearTimer() {
    if (hideTimer) {
      clearTimeout(hideTimer);
      hideTimer = null;
    }
  }

  function clearTransmissionVolumeSettleTimer() {
    if (transmissionVolumeSettleTimer) {
      clearTimeout(transmissionVolumeSettleTimer);
      transmissionVolumeSettleTimer = null;
    }
  }

  function startHideTimer() {
    if (dockedControls) return;
    clearTimer();
    hideTimer = setTimeout(
      () => {
        if (adjustingTransmissionVolume) {
          startHideTimer();
          return;
        }
        if (isSmallScreen || !hoveringControls) controlsVisible = false;
      },
      isSmallScreen ? 1200 : 1800
    );
  }

  function showControls() {
    controlsVisible = true;
    clearTimer();
  }

  function handleTransmissionVolumeChange(v: number) {
    adjustingTransmissionVolume = true;
    showControls();
    setTransmissionOutputVolume?.(v);
    clearTransmissionVolumeSettleTimer();
    transmissionVolumeSettleTimer = setTimeout(() => {
      adjustingTransmissionVolume = false;
      if (!dockedControls) startHideTimer();
    }, 500);
  }

  $effect(() => {
    const el = panelEl;
    if (!el) return;
    const onFsChange = () => {
      isFullscreen = document.fullscreenElement === el;
    };
    document.addEventListener("fullscreenchange", onFsChange);
    return () => document.removeEventListener("fullscreenchange", onFsChange);
  });

  $effect(() => {
    const el = panelEl;
    if (!el) return;

    if (dockedControls) {
      showControls();
      clearTimer();
      return;
    }

    const onMove = () => {
      showControls();
      startHideTimer();
    };
    const onPointerDown = () => {
      showControls();
      startHideTimer();
    };
    const onLeave = () => {
      controlsVisible = false;
      clearTimer();
    };

    el.addEventListener("mousemove", onMove);
    el.addEventListener("pointerdown", onPointerDown);
    el.addEventListener("mouseleave", onLeave);
    startHideTimer();

    return () => {
      el.removeEventListener("mousemove", onMove);
      el.removeEventListener("pointerdown", onPointerDown);
      el.removeEventListener("mouseleave", onLeave);
      clearTimer();
      clearTransmissionVolumeSettleTimer();
    };
  });

  function toggleFullscreen() {
    if (!panelEl) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else panelEl.requestFullscreen().catch(() => {});
  } // ── Visibility conditions ─────────────────────────────────────────────────

  const nobodyInCall = $derived(callPeerIds.size === 0 && !inCall);
  const othersInCallNotUs = $derived(callPeerIds.size > 0 && !inCall);
</script>

<!-- ── CallTile snippet ── -->
{#snippet callTile(
  tile: TileData,
  isFocused: boolean,
  isSpeaking: boolean,
  isOnlyOne: boolean,
  compact: boolean,
  onFocus: () => void,
  onUnfocus: () => void
)}
  {@const hasVideo = tile.videoTrack !== null}
  {@const isPendingTx = tile.kind === "transmission" && tile.isPending}
  <button
    type="button"
    class="group relative flex items-center justify-center overflow-hidden rounded-lg bg-muted/30 cursor-pointer transition-shadow duration-200
      {isFocused ? 'w-full h-full' : ''}
      {compact ? 'aspect-video' : ''}
      {isSpeaking
      ? 'ring-2 ring-primary shadow-[0_0_8px_rgba(0,255,136,0.4)]'
      : ''}
      {isPendingTx ? 'ring-1 ring-primary/40 hover:ring-primary/80' : ''}"
    onclick={() => {
      if (isPendingTx) {
        // Join this transmission (opt-in)
        if (tile.producerId) {
          watchTransmission(tile.peerId, tile.producerId);
        }
        return;
      }
      if (isOnlyOne) return;
      if (isFocused) onUnfocus();
      else onFocus();
    }}
    aria-label={isPendingTx
      ? `Watch ${tile.label}'s transmission`
      : isFocused
        ? "Minimize tile"
        : `Focus ${tile.label}`}
  >
    {#if hasVideo}
      <video
        autoplay
        playsinline
        muted
        class="h-full w-full object-contain {tile.isLocal &&
        tile.kind === 'camera'
          ? '-scale-x-100'
          : ''}"
        use:videoAction={tile.videoTrack!}
      ></video>
    {:else if !isPendingTx}
      <div
        class="relative flex items-center justify-center rounded-full bg-primary/20 font-semibold text-primary overflow-hidden font-mono transition-shadow duration-200
        {compact ? 'size-8 text-sm' : 'size-16 text-2xl'}"
      >
        {#if tile.avatarUrl}
          <img
            src={tile.avatarUrl}
            alt={tile.label}
            class="size-full object-cover"
          />
        {:else}
          {tile.label.charAt(0).toUpperCase()}
        {/if}
      </div>
    {/if}

    <!-- Pending transmission overlay — "Click to watch" -->
    {#if isPendingTx}
      <div class="absolute inset-0 grid place-items-center bg-muted/30">
        <div
          class="rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs font-mono text-foreground shadow-sm transition-all group-hover:border-primary/50 group-hover:shadow-md"
        >
          Click to watch {tile.label}
        </div>
      </div>
    {/if}

    <!-- Name badge -->
    {#if !isPendingTx}
      <div
        class="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 pointer-events-none"
      >
        {#if tile.kind === "screen" || tile.kind === "transmission"}
          <MonitorIcon class="size-3 text-white" />
        {/if}
        {#if tile.kind === "camera" && tile.muted}
          <MicOff class="size-3 text-red-400" />
        {/if}
        {#if tile.kind === "camera" && tile.deafened}
          <HeadphoneOff class="size-3 text-amber-300" />
        {/if}
        <span class="text-xs mt-0.75 leading-none text-white font-mono">
          {tile.kind === "transmission"
            ? `${tile.label}'s transmission`
            : tile.isLocal
              ? `${tile.label} (You)`
              : tile.label}
        </span>
        {#if !tile.isLocal && tile.kind === "camera" && isRelayed(tile.peerId)}
          <Workflow class="size-3 text-blue-400 ml-1" />
        {/if}
      </div>
    {/if}
  </button>
{/snippet}

{#if nobodyInCall}
  <!-- render nothing -->
{:else if othersInCallNotUs}
  <div
    class="flex flex-col border-b border-border shrink-0 h-[12vh] sm:h-[16vh] pb-14 relative bg-background"
  >
    {#if error}<p class="text-sm text-destructive px-3 pt-1.5">{error}</p>{/if}
    <div class="flex-1 flex items-center justify-center">
      <div class="flex items-center gap-1">
        {#each [...callPeerIds] as peerId (peerId)}
          {@const label = getPeerLabel(peerId)}
          {@const avatar = getPeerAvatar(peerId)}
          {@const state = callPeerStates.get(peerId)}
          {@const relayed = isRelayed(peerId)}
          <div
            title={label}
            class="relative flex size-16 sm:size-20 items-center justify-center rounded-full bg-primary/20 text-2xl font-semibold text-primary ring-2 ring-background font-mono overflow-hidden"
          >
            {#if avatar}
              <img src={avatar} alt={label} class="size-full object-cover" />
            {:else}
              {label.charAt(0).toUpperCase()}
            {/if}
            {#if relayed}
              <div
                class="absolute -top-1 -right-1 bg-blue-500 rounded-full p-0.5"
              >
                <Workflow class="size-3 text-white" />
              </div>
            {/if}

            {#if state?.muted || state?.deafened}
              <div
                class="absolute right-1 bottom-1 inline-flex items-center gap-1 rounded-full bg-black/70 px-1 py-0.5"
              >
                {#if state?.muted}
                  <MicOff class="size-3 text-red-400" />
                {/if}
                {#if state?.deafened}
                  <HeadphoneOff class="size-3 text-amber-300" />
                {/if}
              </div>
            {/if}
          </div>
        {/each}
      </div>
    </div>
    <div class="absolute bottom-3 left-1/2 -translate-x-1/2">
      <button
        type="button"
        onclick={joinCall}
        class="group relative flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-all duration-200 hover:bg-primary/90 hover:scale-105 hover:shadow-primary/50"
      >
        <Phone class="size-4" />
        Join Call
      </button>
    </div>
  </div>
{:else if inCall}
  <div
    bind:this={panelEl}
    class="flex flex-col border-b border-border relative shrink-0 bg-background
      {isFullscreen ? 'h-screen' : rowClass}
      {!isFullscreen && !hasActiveVideo ? 'pb-14' : ''}"
  >
    {#if error}<p class="text-sm text-destructive px-3 pt-1.5">{error}</p>{/if}

    <!-- Always-mounted remote audio elements -->
    {#each remoteAudio as a (a.id)}
      <!-- svelte-ignore a11y_media_has_caption -->
      <audio data-remote style="display:none" autoplay use:audioAction={a.track}
      ></audio>
    {/each}

    <!-- Tile area -->
    <div class="relative flex-1 min-h-0 overflow-hidden p-1.5">
      {#if focusedTile}
        <div class="flex h-full gap-1.5">
          <div class="flex-1 min-w-0">
            {@render callTile(
              focusedTile,
              true,
              focusedTile.kind === "camera" &&
                speakingPeers.has(focusedTile.peerId),
              false,
              false,
              () => {},
              () => (focusedTileId = null)
            )}
          </div>
          {#if thumbnailTiles.length > 0}
            <div
              class="flex flex-col gap-1 overflow-y-auto w-20 sm:w-28 shrink-0"
            >
              {#each thumbnailTiles as tile (tile.id)}
                {@render callTile(
                  tile,
                  false,
                  tile.kind === "camera" && speakingPeers.has(tile.peerId),
                  false,
                  true,
                  () => (focusedTileId = tile.id),
                  () => (focusedTileId = null)
                )}
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <div class="grid h-full auto-rows-fr gap-1.5 {gridCols}">
          {#each tiles as tile (tile.id)}
            {@render callTile(
              tile,
              false,
              tile.kind === "camera" && speakingPeers.has(tile.peerId),
              tiles.length === 1,
              false,
              () => (focusedTileId = tile.id),
              () => (focusedTileId = null)
            )}
          {/each}
        </div>
      {/if}
    </div>

    <!-- Call controls -->
    <div
      role="group"
      aria-label="Call controls"
      class={cn(
        "transition-all duration-300 absolute left-1/2 -translate-x-1/2 z-20",
        isSmallScreen ? "bottom-2 w-[calc(100%-1rem)] max-w-120" : "bottom-4",
        !dockedControls &&
          !controlsVisible &&
          "opacity-0 pointer-events-none translate-y-4"
      )}
      onmouseenter={() => {
        if (isSmallScreen) return;
        hoveringControls = true;
        showControls();
      }}
      onmouseleave={() => {
        if (isSmallScreen) return;
        hoveringControls = false;
        if (!dockedControls) startHideTimer();
      }}
    >
      {#if isSmallScreen}
        <div class="grid grid-cols-3 items-center gap-2">
          <div class="flex justify-start">
            <div
              class="flex gap-2 rounded-xl border border-white/10 bg-zinc-900/95 px-2.5 py-2"
            >
              <button
                type="button"
                onclick={toggleMute}
                aria-label={muted ? "Unmute microphone" : "Mute microphone"}
                class="group relative flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-200 shrink-0
                {muted
                  ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 ring-1 ring-red-500/50'
                  : 'bg-white/10 text-zinc-100 hover:bg-white/20'}"
              >
                {#if muted}
                  <MicOff class="size-4" />
                {:else}
                  <Mic class="size-4" />
                {/if}
              </button>
              <button
                type="button"
                onclick={toggleCamera}
                aria-label={cameraOff ? "Turn on camera" : "Turn off camera"}
                class="group relative flex h-8 w-8 items-center justify-center rounded-lg transition-all duration-200 shrink-0
                  {!cameraOff
                  ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 ring-1 ring-red-500/50'
                  : 'bg-white/10 text-zinc-100 hover:bg-white/20'}"
              >
                {#if cameraOff}
                  <Camera class="size-4" />
                {:else}
                  <CameraOff class="size-4" />
                {/if}
              </button>
              <button
                type="button"
                onclick={screenSharing ? stopScreenShare : startScreenShare}
                aria-label={screenSharing
                  ? "Stop transmission"
                  : "Start transmission"}
                title={screenSharing
                  ? "Stop transmission"
                  : "Start transmission"}
                class="flex group relative h-8 w-8 items-center justify-center rounded-lg transition-all duration-200 shrink-0
                  {screenSharing
                  ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 ring-1 ring-red-500/50'
                  : 'bg-white/10 text-zinc-100 hover:bg-white/20'}"
              >
                {#if screenSharing}
                  <MonitorOff class="size-4" />
                {:else}
                  <Monitor class="size-4" />
                {/if}
              </button>
            </div>
          </div>

          <div class="flex justify-center">
            <button
              type="button"
              onclick={leaveCall}
              aria-label="Leave call"
              class="group relative flex h-8 w-14 items-center justify-center rounded-lg bg-linear-to-br from-red-500 to-red-600 text-white shadow-lg shadow-red-500/30 transition-all duration-200 hover:from-red-400 hover:to-red-500"
            >
              <PhoneOff class="size-4" />
            </button>
          </div>

          <div class="flex justify-end">
            {#if isWatchingTransmission}
              <div
                class="relative flex items-center gap-2 rounded-xl border border-white/10 bg-zinc-900/95 px-2 py-2"
              >
                <button
                  type="button"
                  onclick={stopWatchingTransmission}
                  aria-label="Stop watching transmission"
                  title="Stop watching transmission"
                  class="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/20 text-red-400 transition-all duration-200 hover:bg-red-500/30 ring-1 ring-red-500/50"
                >
                  <Radio class="size-4" />
                </button>
                <button
                  type="button"
                  onclick={() => {
                    showTransmissionVolume = !showTransmissionVolume;
                  }}
                  aria-label={transmissionOutputVolume === 0
                    ? "Unmute transmission"
                    : "Mute transmission"}
                  class="flex h-8 w-8 items-center justify-center rounded-lg text-zinc-400 hover:text-zinc-100 transition-colors"
                >
                  {#if transmissionOutputVolume === 0}
                    <VolumeX class="size-4 shrink-0" />
                  {:else if transmissionOutputVolume < 1}
                    <Volume1 class="size-4 shrink-0" />
                  {:else}
                    <Volume2 class="size-4 shrink-0" />
                  {/if}
                </button>

                {#if showTransmissionVolume}
                  <div
                    class="absolute right-0 bottom-[calc(100%+0.45rem)] w-32 rounded-lg border border-white/10 bg-zinc-900 px-2.5 py-2 shadow-lg"
                  >
                    <Slider
                      type="single"
                      min={0}
                      max={1}
                      step={0.05}
                      value={transmissionOutputVolume}
                      onValueChange={handleTransmissionVolumeChange}
                      class="w-full"
                    />
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        </div>
      {:else}
        <div class="flex items-end gap-4">
          <div
            class={cn(
              "flex gap-2",
              !dockedControls &&
                "bg-zinc-900/95 border border-white/10 rounded-xl p-3 py-2"
            )}
          >
            <button
              type="button"
              onclick={toggleMute}
              aria-label={muted ? "Unmute microphone" : "Mute microphone"}
              class="group relative flex h-8 w-8 md:h-10 md:w-10 items-center justify-center rounded-lg transition-all duration-200 shrink-0
              {muted
                ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 ring-1 ring-red-500/50'
                : 'bg-white/10 text-zinc-100 hover:bg-white/20 hover:scale-105'}"
            >
              {#if muted}
                <MicOff class="size-4" />
              {:else}
                <Mic class="size-4" />
              {/if}
            </button>
            <button
              type="button"
              onclick={toggleCamera}
              aria-label={cameraOff ? "Turn on camera" : "Turn off camera"}
              class="group relative flex h-8 w-8 md:h-10 md:w-10 items-center justify-center rounded-lg transition-all duration-200 shrink-0
                {!cameraOff
                ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 ring-1 ring-red-500/50'
                : 'bg-white/10 text-zinc-100 hover:bg-white/20 hover:scale-105'}"
            >
              {#if cameraOff}
                <Camera class="size-4" />
              {:else}
                <CameraOff class="size-4" />
              {/if}
            </button>

            <button
              type="button"
              onclick={screenSharing ? stopScreenShare : startScreenShare}
              aria-label={screenSharing
                ? "Stop transmission"
                : "Start transmission"}
              title={screenSharing ? "Stop transmission" : "Start transmission"}
              class="flex group relative h-8 w-8 md:h-10 md:w-10 items-center justify-center rounded-lg transition-all duration-200 shrink-0
                {screenSharing
                ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30 ring-1 ring-red-500/50'
                : 'bg-white/10 text-zinc-100 hover:bg-white/20 hover:scale-105'}"
            >
              {#if screenSharing}
                <MonitorOff class="size-4" />
              {:else}
                <Monitor class="size-4" />
              {/if}
            </button>
          </div>

          <button
            type="button"
            onclick={leaveCall}
            aria-label="Leave call"
            class={cn(
              "group relative flex items-center justify-center rounded-lg bg-linear-to-br from-red-500 to-red-600 text-white shadow-lg shadow-red-500/30 transition-all duration-200 hover:from-red-400 hover:to-red-500 hover:scale-105 hover:shadow-red-500/50 shrink-0",
              dockedControls
                ? "h-8 w-16 md:h-10 md:w-16"
                : "h-14 w-14 rounded-xl"
            )}
          >
            <PhoneOff class={dockedControls ? "md:size-5 size-4" : "size-5"} />
          </button>

          {#if isWatchingTransmission}
            <div
              class="relative flex items-center gap-2 rounded-xl bg-zinc-900/95 border border-white/10 p-3 py-2"
            >
              <button
                type="button"
                onclick={stopWatchingTransmission}
                aria-label="Stop watching transmission"
                title="Stop watching transmission"
                class="flex h-10 w-10 items-center justify-center rounded-lg bg-red-500/20 text-red-400 transition-all duration-200 hover:bg-red-500/30 ring-1 ring-red-500/50"
              >
                <Radio class="size-4" />
              </button>
              <div class="flex items-center gap-2 px-1">
                <button
                  type="button"
                  onclick={() =>
                    setTransmissionOutputVolume?.(
                      transmissionOutputVolume === 0 ? 1 : 0
                    )}
                  aria-label={transmissionOutputVolume === 0
                    ? "Unmute transmission"
                    : "Mute transmission"}
                  class="flex items-center justify-center text-zinc-400 hover:text-zinc-100 transition-colors"
                >
                  {#if transmissionOutputVolume === 0}
                    <VolumeX class="size-4 shrink-0" />
                  {:else if transmissionOutputVolume < 1}
                    <Volume1 class="size-4 shrink-0" />
                  {:else}
                    <Volume2 class="size-4 shrink-0" />
                  {/if}
                </button>
                <div class="w-24">
                  <Slider
                    type="single"
                    min={0}
                    max={1}
                    step={0.05}
                    value={transmissionOutputVolume}
                    onValueChange={handleTransmissionVolumeChange}
                    class="w-24"
                  />
                </div>
              </div>
            </div>
          {/if}
        </div>
      {/if}
    </div>

    <button
      type="button"
      onclick={toggleFullscreen}
      aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
      title={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
      class="absolute top-3 right-3 sm:top-4 sm:right-4 flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-lg bg-zinc-900 text-zinc-300 transition-all duration-200 hover:bg-zinc-900 hover:scale-105 z-20"
    >
      {#if isFullscreen}
        <Minimize class="size-4" />
      {:else}
        <Maximize class="size-4" />
      {/if}
    </button>
  </div>
{/if}
