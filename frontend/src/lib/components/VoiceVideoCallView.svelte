<script lang="ts">
  import type { ParticipantState } from "$lib/transport.svelte";
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
  } from "@lucide/svelte";
  import { MonitorIcon } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import { profileStore, loadProfile } from "$lib/profile.svelte";

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
    /** True when this is a screen-share transmission tile that hasn't been joined yet. */
    isPending?: boolean;
    /** The SFU producerId — only set on pending transmission tiles. */
    producerId?: string;
  }

  interface Props {
    participants: Map<string, ParticipantState>;
    localCameraStream: MediaStream | null;
    localScreenStream: MediaStream | null;
    localMicStream: MediaStream | null;
    inCall: boolean;
    muted: boolean;
    cameraOff: boolean;
    screenSharing: boolean;
    selfId: string;
    callPeerIds?: Set<string>;
    peerNames?: Map<string, string>;
    peerAvatars?: Map<string, string>;
    peerIdToDidFn?: (peerId: string) => string;
    /** Pending (not yet watched) screen-share transmissions: peerId → producerId */
    pendingTransmissions?: Map<string, string>;
    /** The peerId whose transmission we are currently watching, or null */
    watchingTransmissionPeerId?: string | null;
    onJoinCall: () => void;
    onLeaveCall: () => void;
    onToggleMute: () => void;
    onToggleCamera: () => void;
    onStartScreenShare: () => void;
    onStopScreenShare: () => void;
    onWatchTransmission?: (peerId: string, producerId: string) => void;
    onStopWatchingTransmission?: () => void;
    transmissionOutputVolume?: number;
    onTransmissionOutputVolumeChange?: (volume: number) => void;
    error?: string | null;
  }

  let {
    participants,
    localCameraStream,
    localScreenStream,
    localMicStream,
    inCall,
    muted,
    cameraOff,
    screenSharing,
    selfId,
    callPeerIds = new Set<string>(),
    peerNames = new Map<string, string>(),
    peerAvatars = new Map<string, string>(),
    peerIdToDidFn = (id: string) => id,
    pendingTransmissions = new Map<string, string>(),
    watchingTransmissionPeerId = null,
    onJoinCall,
    onLeaveCall,
    onToggleMute,
    onToggleCamera,
    onStartScreenShare,
    onStopScreenShare,
    onWatchTransmission,
    onStopWatchingTransmission,
    transmissionOutputVolume = 1,
    onTransmissionOutputVolumeChange,
    error = null,
  }: Props = $props();

  // ── Active speaker detection ──────────────────────────────────────────────

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
      if (peerId !== selfId && !seen.has(peerId)) {
        stopSpeakerDetection(peerId);
      }
    }
    if (!muted && localMicStream) {
      const track = localMicStream.getAudioTracks()[0];
      if (track) startSpeakerDetection(selfId, track);
    } else {
      stopSpeakerDetection(selfId);
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
      peerId: selfId,
      muted,
    });
    for (const peerId of callPeerIds) {
      const p = byPeer.get(peerId) ?? {
        peerId,
        audioTrack: null,
        videoTrack: null,
        screenTrack: null,
        screenAudioTrack: null,
      };
      const did = peerIdToDidFn(peerId);
      const label = peerNames.get(did) ?? peerId.slice(0, 8);
      const avatarUrl = peerAvatars.get(did) ?? null;
      result.push({
        id: `remote-camera-${peerId}`,
        label,
        avatarUrl,
        isLocal: false,
        kind: "camera",
        videoTrack: p.videoTrack,
        audioTrack: p.audioTrack,
        peerId,
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
        peerId: selfId,
      });
    }
    for (const p of byPeer.values()) {
      if (p.screenTrack) {
        const did = peerIdToDidFn(p.peerId);
        const label = peerNames.get(did) ?? p.peerId.slice(0, 8);
        const avatarUrl = peerAvatars.get(did) ?? null;
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
      const did = peerIdToDidFn(peerId);
      const label = peerNames.get(did) ?? peerId.slice(0, 8);
      const avatarUrl = peerAvatars.get(did) ?? null;
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
    for (const p of participants.values()) {
      if (p.audioTrack) tracks.push({ id: `${p.peerId}-voice`, track: p.audioTrack });
      if (p.screenAudioTrack) tracks.push({ id: `${p.peerId}-screen`, track: p.screenAudioTrack });
    }
    return tracks;
  });

  const gridCols = $derived.by(() => {
    const n = tiles.length;
    if (n <= 1) return "grid-cols-1";
    if (n <= 4) return "grid-cols-1 sm:grid-cols-2";
    if (n <= 9) return "grid-cols-2 sm:grid-cols-3";
    return "grid-cols-2 sm:grid-cols-4";
  });

  const rowClass = $derived.by(() => {
    const n = tiles.length;
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    const rows = Math.ceil(n / cols);
    if (!hasActiveVideo) return "h-[15vh] sm:h-[20vh]";
    return rows <= 1 ? "h-[22.5vh] sm:h-[35vh]" : "h-[45vh] sm:h-[45vh]";
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
  let hideTimer: ReturnType<typeof setTimeout> | null = null;

  function startHideTimer(delay: number) {
    if (!isFullscreen && !hasActiveVideo) return;
    controlsVisible = true;
    if (hideTimer) clearTimeout(hideTimer);
    hideTimer = setTimeout(() => {
      if (!hoveringControls) controlsVisible = false;
    }, delay);
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
    if (!isFullscreen && !hasActiveVideo) {
      controlsVisible = true;
      if (hideTimer) clearTimeout(hideTimer);
      return;
    }
    const onEnter = () => startHideTimer(3000);
    const onLeave = () => startHideTimer(120);
    const onMove = () => startHideTimer(isFullscreen ? 3000 : 120);
    el.addEventListener("mouseenter", onEnter);
    el.addEventListener("mouseleave", onLeave);
    el.addEventListener("mousemove", onMove);
    return () => {
      el.removeEventListener("mouseenter", onEnter);
      el.removeEventListener("mouseleave", onLeave);
      el.removeEventListener("mousemove", onMove);
      if (hideTimer) clearTimeout(hideTimer);
    };
  });

  function toggleFullscreen() {
    if (!panelEl) return;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else panelEl.requestFullscreen().catch(() => {});
  }

  // ── Visibility conditions ─────────────────────────────────────────────────

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
      ? 'ring-2 ring-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.4)]'
      : ''}
      {isPendingTx ? 'ring-1 ring-primary/40 hover:ring-primary/80' : ''}"
    onclick={() => {
      if (isPendingTx) {
        // Join this transmission (opt-in)
        if (onWatchTransmission && tile.producerId) {
          onWatchTransmission(tile.peerId, tile.producerId);
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
      class="absolute bottom-1.5 left-1.5 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5"
      >
        {#if tile.kind === "screen" || tile.kind === "transmission"}
          <MonitorIcon class="size-3 text-white" />
        {/if}
        {#if tile.kind === "camera" && tile.muted}
          <MicOff class="size-3 text-red-400" />
        {/if}
        <span class="text-[11px] leading-none text-white font-mono">
          {tile.kind === "transmission"
            ? `${tile.label}'s transmission`
            : tile.isLocal
              ? `${tile.label} (You)`
              : tile.label}
        </span>
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
          {@const did = peerIdToDidFn(peerId)}
          <div
            title={peerNames.get(did) ?? peerId}
            class="flex size-16 sm:size-20 items-center justify-center rounded-full bg-primary/20 text-2xl font-semibold text-primary ring-2 ring-background font-mono overflow-hidden"
          >
            {#if peerAvatars.get(did)}
              <img
                src={peerAvatars.get(did)}
                alt={peerNames.get(did) ?? peerId}
                class="size-full object-cover"
              />
            {:else}
              {(peerNames.get(did) ?? peerId).charAt(0).toUpperCase()}
            {/if}
          </div>
        {/each}
      </div>
    </div>
    <div class="absolute bottom-3 left-1/2 -translate-x-1/2">
      <Button
        variant="secondary"
        size="sm"
        onclick={onJoinCall}
        class="gap-1.5 cursor-pointer font-mono text-xs"
      >
        <Phone class="size-3.5" />
        Join Call
      </Button>
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
      <audio style="display:none" autoplay use:audioAction={a.track}
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
      class="flex items-center justify-center gap-2 transition-all duration-300 absolute bottom-3 left-1/2 -translate-x-1/2 rounded-full bg-black/70 px-4 py-1 backdrop-blur-sm z-10
        {isFullscreen && !controlsVisible
        ? 'translate-y-[calc(100%+2rem)] opacity-0 pointer-events-none'
        : ''}
        {!isFullscreen && hasActiveVideo && !controlsVisible
        ? 'opacity-0 pointer-events-none'
        : ''}"
      onmouseenter={() => {
        hoveringControls = true;
        controlsVisible = true;
        if (hideTimer) clearTimeout(hideTimer);
      }}
      onmouseleave={() => {
        hoveringControls = false;
        startHideTimer(isFullscreen ? 3000 : 120);
      }}
    >
      <Button
        variant={muted ? "destructive" : "secondary"}
        size="icon"
        class="size-11 sm:size-8 cursor-pointer"
        onclick={onToggleMute}
        aria-label={muted ? "Unmute microphone" : "Mute microphone"}
      >
        {#if muted}<MicOff class="size-4 sm:size-3.5" />{:else}<Mic
            class="size-4 sm:size-3.5"
          />{/if}
      </Button>

      <Button
        variant={cameraOff ? "secondary" : "destructive"}
        size="icon"
        class="size-11 sm:size-8 cursor-pointer"
        onclick={onToggleCamera}
        aria-label={cameraOff ? "Turn on camera" : "Turn off camera"}
      >
        {#if cameraOff}<Camera class="size-4 sm:size-3.5" />{:else}<CameraOff
            class="size-4 sm:size-3.5"
          />{/if}
      </Button>

      <Button
        variant={screenSharing ? "destructive" : "secondary"}
        size="icon"
        class="size-11 sm:size-8 hidden sm:inline-flex cursor-pointer"
        onclick={screenSharing ? onStopScreenShare : onStartScreenShare}
        aria-label={screenSharing
          ? "Stop transmission"
          : "Start transmission (screen share)"}
        title={screenSharing ? "Stop transmission" : "Start transmission"}
      >
        {#if screenSharing}<MonitorOff
            class="size-4 sm:size-3.5"
          />{:else}<Monitor class="size-4 sm:size-3.5" />{/if}
      </Button>

      {#if isWatchingTransmission}
        <Button
          variant="destructive"
          size="icon"
          class="size-11 sm:size-8 cursor-pointer"
          onclick={onStopWatchingTransmission}
          aria-label="Stop watching transmission"
          title="Stop watching transmission"
        >
          <Radio class="size-4 sm:size-3.5" />
        </Button>

        <div class="hidden sm:flex items-center gap-2 px-2">
          <input
            type="range"
            min="0"
            max="2"
            step="0.05"
            value={transmissionOutputVolume}
            oninput={(e) =>
              onTransmissionOutputVolumeChange?.(
                Number((e.currentTarget as HTMLInputElement).value)
              )}
            class="w-24 accent-primary"
            aria-label="Transmission volume"
            title="Transmission volume"
          />
        </div>
      {/if}

      <Button
        variant="destructive"
        size="icon"
        class="size-11 sm:size-8 cursor-pointer"
        onclick={onLeaveCall}
        aria-label="Leave call"
      >
        <PhoneOff class="size-4 sm:size-3.5" />
      </Button>

      <Button
        variant="secondary"
        size="icon"
        class="size-11 sm:size-8 hidden sm:inline-flex cursor-pointer"
        onclick={toggleFullscreen}
        aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
      >
        {#if isFullscreen}<Minimize
            class="size-4 sm:size-3.5"
          />{:else}<Maximize class="size-4 sm:size-3.5" />{/if}
      </Button>
    </div>
  </div>
{/if}
