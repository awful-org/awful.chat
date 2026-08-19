<script lang="ts">
  import { onDestroy } from "svelte";
  import { Tip } from "$lib/components/ui/tooltip";
  import { formatReactorNames } from "$lib/reaction-names";
  import GifImage from "./GifImage.svelte";
  import { RELAY_TIP } from "$lib/copy";
  import { openDmConversation } from "$lib/transport/dm.svelte";
  import {
    getVoicePeerVolume,
    setVoicePeerVolume,
  } from "$lib/transport/voice.svelte";
  import {
    UNITY_STOP,
    formatGain,
    gainToSlider,
    sliderToGain,
  } from "$lib/audio/volume-curve";
  import {
    transportState,
    _transport,
    selfId,
    peerIdToDid,
    isRelayed,
    peerId as selfPeerId,
  } from "$lib/transport/transport.svelte";
  import {
    setTransmissionOutputVolume,
    stopWatchingTransmission,
    watchTransmission,
  } from "$lib/transport/transmission.svelte";
  import {
    joinCall,
    leaveCall,
    startScreenShare,
    stopScreenShare,
    toggleCamera,
    toggleMute,
  } from "$lib/transport/call.svelte";

  import {
    Eye,
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
  import { MessageSquare, MonitorIcon, Users as UsersIcon } from "@lucide/svelte";
import { profileStore, loadProfile } from "$lib/profile.svelte";
import { displayPrefs } from "$lib/display-prefs.svelte";
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
    /** Announced in the call but their voice link is not up yet. */
    connecting?: boolean;
    /** True when this is a screen-share transmission tile that hasn't been joined yet. */
    isPending?: boolean;
    /** The SFU producerId - only set on pending transmission tiles. */
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

  const callMembers = $derived.by(() => {
    const names = [...callPeerIds].map(getPeerLabel);
    return {
      count: names.length + (transportState.inCall ? 1 : 0),
      label: formatReactorNames(names, transportState.inCall),
    };
  });

  function transmissionAudience(sharerPeerId: string): {
    count: number;
    label: string;
  } {
    const remote = [
      ...(transportState.transmissionViewers.get(sharerPeerId) ?? []),
    ];
    const self =
      transportState.watchingTransmissionPeerId === sharerPeerId;
    return {
      count: remote.length + (self ? 1 : 0),
      label: formatReactorNames(remote.map(getPeerLabel), self),
    };
  }

  function getPeerAvatar(peerId: string): string | null {
    const did = peerIdToDid(peerId);
    return peerAvatars.get(did) ?? peerAvatars.get(peerId) ?? null;
  }

  function getPeerColor(peerId: string): string | null {
    if (peerId === selfId() || peerId === selfPeerId()) {
      return profileStore.color ?? null;
    }
    if (!displayPrefs.showPeerNicknameColors) return null;
    const did = peerIdToDid(peerId);
    return (
      transportState.peerColors.get(peerId) ??
      (did ? transportState.peerColors.get(did) : undefined) ??
      null
    );
  }

  // ── Per-peer volume menu ──────────────────────────────────────────────────

  let peerMenu = $state<{
    peerId: string;
    label: string;
    x: number;
    y: number;
  } | null>(null);
  let peerVolumeSlider = $state(UNITY_STOP);

  const peerVolumePercent = $derived(formatGain(sliderToGain(peerVolumeSlider)));

  function openPeerMenu(e: MouseEvent, tile: TileData): void {
    if (tile.isLocal || !tile.peerId) return;
    e.preventDefault();
    e.stopPropagation();
    peerVolumeSlider = gainToSlider(getVoicePeerVolume(tile.peerId));
    const width = 224;
    const height = 132;
    const pad = 8;
    peerMenu = {
      peerId: tile.peerId,
      label: tile.label,
      x: Math.max(pad, Math.min(e.clientX, window.innerWidth - width - pad)),
      y: Math.max(pad, Math.min(e.clientY, window.innerHeight - height - pad)),
    };
  }

  function closePeerMenu(): void {
    peerMenu = null;
  }

  function onPeerVolume(value: number): void {
    peerVolumeSlider = value;
    if (peerMenu) setVoicePeerVolume(peerMenu.peerId, sliderToGain(value));
  }

  async function dmFromPeerMenu(): Promise<void> {
    const peerId = peerMenu?.peerId;
    closePeerMenu();
    if (peerId) await openDmConversation(peerId);
  }

  let speakingPeers = $state(new Set<string>());
  const analysers = new Map<
    string,
    {
      analyser: AnalyserNode;
      source: MediaStreamAudioSourceNode;
      track: MediaStreamTrack;
    }
  >();

  // One context for everyone. A context per peer meant every track event closed
  // and reopened all of them, and browsers cap how many can exist at once - once
  // that cap was hit the constructor threw and the ring never came back.
  let sharedCtx: AudioContext | null = null;

  function speakerCtx(): AudioContext {
    if (!sharedCtx || sharedCtx.state === "closed") {
      sharedCtx = new AudioContext();
    }
    // A context created without a user gesture, or suspended while the tab sat
    // in the background, reports silence until it is resumed - which is the
    // other way the ring used to stop for good.
    if (sharedCtx.state === "suspended") sharedCtx.resume().catch(() => {});
    return sharedCtx;
  }

  function startSpeakerDetection(peerId: string, track: MediaStreamTrack) {
    const existing = analysers.get(peerId);
    if (existing) {
      // Same track and still live: nothing to do. A track that has ended (the
      // mic was restarted underneath us) has to be rewired, not kept.
      if (existing.track === track && track.readyState === "live") return;
      stopSpeakerDetection(peerId);
    }
    if (track.readyState !== "live") return;
    try {
      const ctx = speakerCtx();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 512;
      const source = ctx.createMediaStreamSource(new MediaStream([track]));
      source.connect(analyser);
      analysers.set(peerId, { analyser, source, track });
    } catch {
      // ignore
    }
  }

  function stopSpeakerDetection(peerId: string) {
    const entry = analysers.get(peerId);
    if (!entry) return;
    entry.source.disconnect();
    analysers.delete(peerId);
    lastLoudAt.delete(peerId);
    speakingPeers = new Set([...speakingPeers].filter((p) => p !== peerId));
  }

  let rafId: number | null = null;

  // Speech has gaps between syllables, so a bare per-frame threshold makes the
  // ring strobe. Hold it on briefly after the last loud frame, and use a lower
  // threshold to stay on than to switch on.
  const SPEAKING_HOLD_MS = 500;
  const SPEAKING_ON = 5;
  const SPEAKING_OFF = 2;
  const lastLoudAt = new Map<string, number>();

  // Peers whose voice ICE actually completed - a roster tile without a track
  // AND without this is still connecting, and must not render as present.
  let iceConnectedPeers = $state(new Set<string>());
  $effect(() => {
    const onStatus = (st: { type: string; peerId?: string }) => {
      if (st.type === "voice-ice-connected" && st.peerId) {
        iceConnectedPeers = new Set([...iceConnectedPeers, st.peerId]);
      }
      if (
        (st.type === "voice-peer-left" ||
          st.type === "voice-connection-failed") &&
        st.peerId
      ) {
        const next = new Set(iceConnectedPeers);
        next.delete(st.peerId);
        iceConnectedPeers = next;
      }
    };
    _transport?.on("status", onStatus);
    return () => _transport?.off("status", onStatus);
  });

  // Hoisted: allocating a fresh buffer per animation frame churned the GC.
  const speakerBuf = new Uint8Array(512);
  // Analysing at 60fps buys nothing over 10Hz for a 500ms-hold ring; the rAF
  // loop stays (it pauses in hidden tabs) but the FFT reads are throttled.
  const SPEAKER_POLL_MS = 100;
  let nextSpeakerPollAt = 0;

  function pollSpeakers() {
    const pollNow = performance.now();
    if (pollNow < nextSpeakerPollAt) {
      rafId = requestAnimationFrame(pollSpeakers);
      return;
    }
    nextSpeakerPollAt = pollNow + SPEAKER_POLL_MS;
    if (sharedCtx?.state === "suspended") sharedCtx.resume().catch(() => {});
    const buf = speakerBuf;
    const now = performance.now();
    const next = new Set<string>();

    for (const [peerId, { analyser }] of analysers) {
      analyser.getByteFrequencyData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) sum += buf[i];
      const avg = sum / buf.length;
      const threshold = speakingPeers.has(peerId) ? SPEAKING_OFF : SPEAKING_ON;
      if (avg > threshold) lastLoudAt.set(peerId, now);
      if (now - (lastLoudAt.get(peerId) ?? -Infinity) < SPEAKING_HOLD_MS) {
        next.add(peerId);
      }
    }

    // This runs every frame: only publish when the set actually changed, or
    // every consumer re-renders 60 times a second for nothing.
    const changed =
      next.size !== speakingPeers.size ||
      [...next].some((peerId) => !speakingPeers.has(peerId));
    if (changed) speakingPeers = next;

    rafId = requestAnimationFrame(pollSpeakers);
  }

  $effect(() => {
    // Track which peers should have analysers
    const desiredPeers = new Set<string>();

    // Add remote peers with audio
    for (const [peerId, p] of participants) {
      if (p.audioTrack) {
        desiredPeers.add(peerId);
      }
    }

    // Add self if not muted
    if (!muted && localMicStream) {
      const track = localMicStream.getAudioTracks()[0];
      if (track) {
        desiredPeers.add(selfId());
      }
    }

    // Create/update analysers for desired peers
    for (const peerId of desiredPeers) {
      const track = peerId === selfId()
        ? localMicStream?.getAudioTracks()[0]
        : participants.get(peerId)?.audioTrack;
      if (track) {
        startSpeakerDetection(peerId, track);
      }
    }

    // Remove analysers for peers no longer desired
    for (const peerId of [...analysers.keys()]) {
      if (!desiredPeers.has(peerId)) {
        stopSpeakerDetection(peerId);
      }
    }

    // Start RAF loop if needed
    if (!rafId && desiredPeers.size > 0) {
      rafId = requestAnimationFrame(pollSpeakers);
    }
    if (rafId && desiredPeers.size === 0) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    // No teardown on re-run: this effect re-runs on every track event, and
    // tearing every analyser down each time is what left peers without one.
  });

  onDestroy(() => {
    if (rafId) cancelAnimationFrame(rafId);
    rafId = null;
    for (const peerId of [...analysers.keys()]) {
      stopSpeakerDetection(peerId);
    }
    sharedCtx?.close().catch(() => {});
    sharedCtx = null;
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
    // Apply saved transmission volume to newly mounted audio element
    node.volume = transmissionOutputVolume;
    node.play().catch(() => {});
    return {
      update(t: MediaStreamTrack) {
        node.srcObject = new MediaStream([t]);
        node.volume = transmissionOutputVolume;
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
        connecting:
          !p.audioTrack && !p.videoTrack && !iceConnectedPeers.has(peerId),
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
    // Pending transmission tiles - remote peers sharing their screen (opt-in)
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

  // Docked only when there is nothing to watch - pure audio call
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

  // The volume popover closes like the peer menu: Escape or a click
  // anywhere outside its own controls.
  $effect(() => {
    if (!showTransmissionVolume) return;
    const close = (e: Event) => {
      if (
        e instanceof KeyboardEvent
          ? e.key === "Escape"
          : !(e.target as HTMLElement | null)?.closest?.(
              "[data-transmission-volume]"
            )
      ) {
        showTransmissionVolume = false;
      }
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", close);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", close);
    };
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

<!-- Error banner (always visible if present) -->
{#if error}
  <div class="flex flex-col border-b border-border shrink-0 bg-background">
    <p class="text-sm text-destructive px-3 pt-1.5">{error}</p>
  </div>
{/if}

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
  {@const tileColor = getPeerColor(tile.peerId)}
  <button
    type="button"
    oncontextmenu={(e) => openPeerMenu(e, tile)}
    class="group relative flex items-center justify-center overflow-hidden rounded-lg bg-muted/30 cursor-pointer transition-shadow duration-200
      {tile.connecting ? 'connecting-wave' : ''}
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
      ? `Watch ${tile.label}'s screen`
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
        class="relative flex items-center justify-center rounded-full {tile.isLocal
          ? 'bg-primary/20 text-primary'
          : 'bg-secondary text-secondary-foreground'} font-semibold overflow-hidden font-mono transition-shadow duration-200
        {compact ? 'size-8 text-sm' : 'size-16 text-2xl'}"
        style={tileColor ? `color: ${tileColor}` : ""}
      >
        {#if tile.avatarUrl}
          <GifImage
            src={tile.avatarUrl}
            alt={tile.label}
            class="size-full object-cover"
            animate={speakingPeers.has(tile.peerId)}
          />
        {:else}
          {tile.label.charAt(0).toUpperCase()}
        {/if}
      </div>
    {/if}

    {#if tile.kind === "screen" || tile.kind === "transmission" || isPendingTx}
      {@const audience = transmissionAudience(tile.peerId)}
      {#if audience.count > 0}
        <Tip text={audience.label}>
          {#snippet children(props)}
            <div
              {...props}
              class="absolute top-1.5 right-1.5 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-mono text-white"
            >
              <Eye class="size-3" />
              {audience.count}
            </div>
          {/snippet}
        </Tip>
      {/if}
    {/if}

    <!-- Pending transmission overlay - "Click to watch" -->
    {#if isPendingTx}
      <div class="absolute inset-0 grid place-items-center bg-muted/30">
        <div
          class="rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs font-mono text-foreground shadow-sm transition-all group-hover:border-primary/50 group-hover:shadow-md"
        >
          Watch {tile.label}'s screen
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
          <HeadphoneOff class="size-3 text-red-400" />
        {/if}
        <span
          class="text-xs mt-0.75 leading-none text-white font-mono"
          style={tileColor ? `color: ${tileColor}` : ""}
        >
          {tile.kind === "transmission"
            ? `${tile.label}'s screen`
            : tile.isLocal
              ? `${tile.label} (You)`
              : tile.label}
        </span>
        {#if !tile.isLocal && isRelayed(tile.peerId)}
          <!-- pointer-events-auto: the badge itself ignores the pointer so it
               does not swallow clicks on the tile, but the tooltip needs the
               hover. -->
          <Tip text={RELAY_TIP} side="top">
            {#snippet children(props)}
              <button
                {...props}
                type="button"
                aria-label="Relayed connection"
                class="pointer-events-auto ml-1 inline-flex cursor-help"
              >
                <Workflow class="size-3 text-blue-400" />
              </button>
            {/snippet}
          </Tip>
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
    <div class="flex-1 flex items-center justify-center">
      <div class="flex items-center gap-1">
        {#each [...callPeerIds] as peerId (peerId)}
          {@const label = getPeerLabel(peerId)}
          {@const avatar = getPeerAvatar(peerId)}
          {@const state = callPeerStates.get(peerId)}
          {@const relayed = isRelayed(peerId)}
          <div
            title={label}
            class="relative flex size-16 sm:size-20 items-center justify-center rounded-full bg-secondary text-2xl font-semibold text-secondary-foreground ring-2 ring-background font-mono overflow-hidden"
          >
            {#if avatar}
              <GifImage
                src={avatar}
                alt={label}
                class="size-full object-cover"
                animate={speakingPeers.has(peerId)}
              />
            {:else}
              {label.charAt(0).toUpperCase()}
            {/if}
            {#if relayed}
              <Tip text={RELAY_TIP} side="top">
                {#snippet children(props)}
                  <button
                    {...props}
                    type="button"
                    aria-label="Relayed connection"
                    class="absolute -top-1 -right-1 cursor-help rounded-full bg-blue-500 p-0.5"
                  >
                    <Workflow class="size-3 text-white" />
                  </button>
                {/snippet}
              </Tip>
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
        disabled={transportState.connecting}
        class="group relative flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-all duration-200 hover:bg-primary/90 hover:scale-105 hover:shadow-primary/50 disabled:opacity-60 disabled:hover:scale-100"
      >
        <Phone class="size-4" />
        {transportState.connecting ? "Connecting..." : "Join call"}
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
                title={muted ? "Unmute microphone" : "Mute microphone"}
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
                title={cameraOff ? "Turn on camera" : "Turn off camera"}
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
                  ? "Stop screen share"
                  : "Share screen"}
                title={screenSharing ? "Stop screen share" : "Share screen"}
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
              title="Leave call"
              class="group relative flex h-8 w-14 items-center justify-center rounded-lg bg-linear-to-br from-red-500 to-red-600 text-white shadow-lg shadow-red-500/30 transition-all duration-200 hover:from-red-400 hover:to-red-500"
            >
              <PhoneOff class="size-4" />
            </button>
          </div>

          <div class="flex justify-end">
            {#if isWatchingTransmission}
              <div
                data-transmission-volume
                class="relative flex items-center gap-2 rounded-xl border border-white/10 bg-zinc-900/95 px-2 py-2"
              >
                <button
                  type="button"
                  onclick={stopWatchingTransmission}
                  aria-label="Stop watching"
                  title="Stop watching"
                  class="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/20 text-red-400 transition-all duration-200 hover:bg-red-500/30 ring-1 ring-red-500/50"
                >
                  <Radio class="size-4" />
                </button>
                <button
                  type="button"
                  onclick={() => {
                    showTransmissionVolume = !showTransmissionVolume;
                  }}
                  aria-label="Screen share volume"
                  aria-expanded={showTransmissionVolume}
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
        <div class="flex items-center gap-4">
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
              title={muted ? "Unmute microphone" : "Mute microphone"}
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
              title={cameraOff ? "Turn on camera" : "Turn off camera"}
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
                ? "Stop screen share"
                : "Share screen"}
              title={screenSharing ? "Stop screen share" : "Share screen"}
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
            title="Leave call"
            class={cn(
              "group relative flex items-center justify-center rounded-lg bg-linear-to-br from-red-500 to-red-600 text-white shadow-lg shadow-red-500/30 transition-all duration-200 hover:from-red-400 hover:to-red-500 hover:scale-105 hover:shadow-red-500/50 shrink-0",
              "h-8 w-16 md:h-10 md:w-16"
            )}
          >
            <PhoneOff class="md:size-5 size-4" />
          </button>

          {#if isWatchingTransmission}
            <div
              class="relative flex items-center gap-2 rounded-xl bg-zinc-900/95 border border-white/10 p-3 py-2"
            >
              <button
                type="button"
                onclick={stopWatchingTransmission}
                aria-label="Stop watching"
                title="Stop watching"
                class="flex h-8 w-8 md:h-10 md:w-10 items-center justify-center rounded-lg bg-red-500/20 text-red-400 transition-all duration-200 hover:bg-red-500/30 ring-1 ring-red-500/50"
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
                    ? "Unmute screen share"
                    : "Mute screen share"}
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

    {#if callMembers.count > 0}
      <Tip text={callMembers.label}>
        {#snippet children(props)}
          <div
            {...props}
            aria-label="Call members"
            class="absolute top-3 right-12 sm:top-4 sm:right-16 z-20 flex h-8 sm:h-10 items-center gap-1.5 rounded-lg bg-zinc-900 px-2.5 font-mono text-xs text-zinc-300"
          >
            <UsersIcon class="size-4" />
            {callMembers.count}
          </div>
        {/snippet}
      </Tip>
    {/if}

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

<svelte:window
  onclick={closePeerMenu}
  onkeydown={(e) => {
    if (e.key === "Escape") closePeerMenu();
  }}
/>

{#if peerMenu}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <div
    role="menu"
    tabindex="-1"
    class="fixed z-50 w-56 rounded-md border border-border bg-popover py-1 shadow-xl font-mono"
    style="top: {peerMenu.y}px; left: {peerMenu.x}px"
    onkeydown={() => {}}
    onclick={(e) => e.stopPropagation()}
    oncontextmenu={(e) => e.preventDefault()}
  >
    <p class="truncate px-3 pb-1 pt-0.5 text-xs text-muted-foreground">
      {peerMenu.label}
    </p>

    <button
      type="button"
      class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted"
      onclick={dmFromPeerMenu}
    >
      <MessageSquare class="size-4" />
      Message
    </button>

    <div class="mt-1 border-t border-border px-3 pb-2 pt-2">
      <div class="flex items-center justify-between pb-1.5">
        <span class="text-xs text-muted-foreground">Volume</span>
        <span
          class="text-xs tabular-nums {peerVolumeSlider <= 0
            ? 'text-destructive'
            : 'text-primary'}">{peerVolumePercent}</span
        >
      </div>
      <input
        type="range"
        min="0"
        max="100"
        step="1"
        value={peerVolumeSlider}
        aria-label={`Volume for ${peerMenu.label}`}
        oninput={(e) => onPeerVolume(Number(e.currentTarget.value))}
        class="h-1 w-full cursor-pointer appearance-none rounded-full accent-primary"
        style={`background: linear-gradient(to right, var(--primary) ${peerVolumeSlider}%, var(--muted) ${peerVolumeSlider}%)`}
      />
      <p class="pt-1 text-[10px] text-muted-foreground">
        Only changes what you hear
      </p>
    </div>
  </div>
{/if}

<style>
  /* Connecting tiles: a pronounced opacity wave - Tailwind's pulse was too
     subtle to read as "not here yet". */
  .connecting-wave {
    animation: connecting-wave 1.4s ease-in-out infinite;
  }
  @keyframes connecting-wave {
    0%,
    100% {
      opacity: 0.9;
    }
    50% {
      opacity: 0.2;
    }
  }
</style>
