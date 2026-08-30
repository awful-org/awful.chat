<script lang="ts">
  import { Tip } from "$lib/components/ui/tooltip";
  import { formatReactorNames } from "$lib/reaction-names";
  import GifImage from "./GifImage.svelte";
  import { RELAY_TIP } from "$lib/copy";
  import { applyVoiceLinkStatus } from "$lib/voice-link-status";
  import { openDmPanel } from "$lib/transport/dm.svelte";
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
    toggleScreenShare,
    stopScreenShare,
    toggleCamera,
    toggleMute,
  } from "$lib/transport/call.svelte";
  import { speakers } from "$lib/speakers.svelte";
  import { callFocus, autofocusEffect } from "$lib/call-focus.svelte";
  import { callPipPanel } from "$lib/call-pip.svelte";
  import { enterBrowserPip, exitBrowserPip } from "$lib/call-spotlight.svelte";
  import { spotlightStore } from "$lib/call-spotlight.svelte";

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
    Puzzle,
    X as XIcon,
    Tv2,
  } from "@lucide/svelte";
  import { Check, Columns2, MessageSquare, MonitorIcon, Rows2, SlidersHorizontal, Users as UsersIcon, UserX } from "@lucide/svelte";
import { profileStore, loadProfile } from "$lib/profile.svelte";
import { displayPrefs, setCallChatBeside, setCallPip } from "$lib/display-prefs.svelte";
import { cn } from "$lib/utils";
import { callTilesState, refreshCallTiles } from "$lib/plugins/call-tiles.svelte";
import { getManifest } from "$lib/plugins/registry";
import { onCardStateChange } from "$lib/plugins/state.svelte";
import PluginCallTileView from "./PluginCallTileView.svelte";
import PluginIcon from "$lib/plugins/PluginIcon.svelte";
import {
  ambientStyle,
  glowFor,
  primeGlow,
  rimStyle,
} from "$lib/avatar-glow.svelte";
  import { Slider } from "./ui/slider";

  interface Props {
    /** The call stage is a column beside the chat, not a band above it. */
    beside?: boolean;
  }
  let { beside = false }: Props = $props();

  $effect(() => {
    loadProfile();
  });

  interface TileData {
    id: string;
    label: string;
    avatarUrl?: string | null;
    isLocal: boolean;
    kind: "camera" | "screen" | "transmission" | "plugin";
    videoTrack: MediaStreamTrack | null;
    audioTrack?: MediaStreamTrack | null;
    peerId: string;
    muted?: boolean;
    deafened?: boolean;
    /** Announced in the call but their voice link is not up yet. */
    connecting?: boolean;
    /** getStats saw the consumer stop advancing - a track object exists
     *  but proves nothing about whether RTP is still arriving
     *  (sfu-audit finding 14). */
    stalled?: boolean;
    /** True when this is a screen-share transmission tile that hasn't been joined yet. */
    isPending?: boolean;
    /** The SFU producerId - only set on pending transmission tiles. */
    producerId?: string;
    /** Plugin tiles: which card renders in this tile. */
    pluginId?: string;
    cardId?: string;
    pluginRoomCode?: string;
    /** Plugin tiles: names using it, for the audience chip. */
    pluginViewers?: string[];
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


  function transmissionAudience(sharerPeerId: string): {
    count: number;
    label: string;
  } {
    // Local tiles carry the DID, but viewers announce the sharer by libp2p
    // peerId - so the sharer's OWN tile looked its audience up under the
    // wrong key and always saw nobody.
    const key = sharerPeerId === selfId() ? selfPeerId() : sharerPeerId;
    const remote = [
      ...(transportState.transmissionViewers.get(key) ?? []),
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

  // ── Context menus ─────────────────────────────────────────────────────────

  let peerMenu = $state<{
    peerId: string;
    label: string;
    x: number;
    y: number;
  } | null>(null);
  /** Right-click on the call background: picks what the grid shows. */
  let viewMenu = $state<{ x: number; y: number } | null>(null);
  let peerVolumeSlider = $state(UNITY_STOP);

  const peerVolumePercent = $derived(formatGain(sliderToGain(peerVolumeSlider)));

  /**
   * Keep a menu of this size inside the viewport. Both menus live inside the
   * panel so they survive fullscreen, and a fixed child of a fullscreen
   * element still measures against the viewport - so these coordinates hold
   * either way.
   */
  function clampMenu(
    e: MouseEvent,
    width: number,
    height: number
  ): { x: number; y: number } {
    const pad = 8;
    return {
      x: Math.max(pad, Math.min(e.clientX, window.innerWidth - width - pad)),
      y: Math.max(pad, Math.min(e.clientY, window.innerHeight - height - pad)),
    };
  }

  function openPeerMenu(e: MouseEvent, tile: TileData): void {
    // The local tile has nothing to offer here, so the event is left to bubble
    // to the panel and open the view menu instead. Plugin tiles are not
    // peers - volume/profile entries would dereference a synthetic id.
    if (tile.isLocal || !tile.peerId || tile.kind === "plugin") return;
    e.preventDefault();
    e.stopPropagation();
    peerVolumeSlider = gainToSlider(getVoicePeerVolume(tile.peerId));
    viewMenu = null;
    peerMenu = { peerId: tile.peerId, label: tile.label, ...clampMenu(e, 224, 132) };
  }

  function openViewMenu(e: MouseEvent): void {
    e.preventDefault();
    peerMenu = null;
    viewMenu = clampMenu(e, 224, 320);
  }

  function closeMenus(): void {
    peerMenu = null;
    viewMenu = null;
  }

  function onPeerVolume(value: number): void {
    peerVolumeSlider = value;
    if (peerMenu) setVoicePeerVolume(peerMenu.peerId, sliderToGain(value));
  }

  /**
   * The floating panel, not the chat pane. Pointing the pane at the DM unmounts
   * this call stage - the stage is gated on the pane showing the call's room -
   * and the pane filters messages by the room the VIEW is on, so the DM
   * rendered as an empty conversation you could send into but never see.
   */
  async function dmFromPeerMenu(): Promise<void> {
    const peerId = peerMenu?.peerId;
    closeMenus();
    if (peerId) await openDmPanel(peerId);
  }

  // Peers whose voice ICE actually completed - a roster tile without a
  // track AND without this is still connecting, and must not render as
  // present. Insert and delete key are the SAME reducer, so they can never
  // drift apart the way an insert-by-full-id/delete-by-short-id split once
  // did (voice-audit finding 8) - a torn-down peer always leaves this set.
  let iceConnectedPeers = $state(new Set<string>());
  $effect(() => {
    const onStatus = (st: { type: string; peerId?: string }) => {
      iceConnectedPeers = new Set(applyVoiceLinkStatus(iceConnectedPeers, st));
    };
    _transport?.on("status", onStatus);
    return () => _transport?.off("status", onStatus);
  });

  // Speaker detection is driven from AppView, NOT here. A $effect in this
  // component dies with it, and this component unmounts the moment the user
  // navigates away from the call room - which is exactly when the floating
  // panel needs the speaker data. Driving it here also meant a call ended from
  // the panel never tore the analysers down, leaking the AudioContext and the
  // poll loop for the rest of the session. This component only READS
  // speakers.speaking for its rings.

  // ── Video / Audio actions ─────────────────────────────────────────────────

  // Both actions skip update when the track is unchanged. Svelte calls an
  // action's update every time its effect re-runs, without comparing the
  // value - and `tiles` rebuilds every tile object on ANY state change (your
  // mute, anyone's mute/deafen, a track event, a profile update). Reattaching
  // srcObject for the same track tears down and re-latches the media
  // pipeline, which is the tile flicker (and the audio glitch) on every
  // mute/deafen toggle.
  function videoAction(node: HTMLVideoElement, track: MediaStreamTrack) {
    let current = track;
    node.srcObject = new MediaStream([track]);
    node.play().catch(() => {});
    return {
      update(t: MediaStreamTrack) {
        if (t === current) return;
        current = t;
        node.srcObject = new MediaStream([t]);
        node.play().catch(() => {});
      },
      destroy() {
        node.srcObject = null;
      },
    };
  }

  function audioAction(node: HTMLAudioElement, track: MediaStreamTrack) {
    let current = track;
    node.srcObject = new MediaStream([track]);
    // Volume on mount only: later changes reach mounted elements through
    // setTransmissionOutputVolume's querySelectorAll("audio[data-remote]").
    node.volume = transmissionOutputVolume;
    node.play().catch(() => {});
    return {
      update(t: MediaStreamTrack) {
        if (t === current) return;
        current = t;
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
        videoStalled: false,
        screenStalled: false,
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
        stalled: p.videoStalled,
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
          stalled: p.screenStalled,
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
    // Plugin tiles: the plugin joins the grid as a "streamer". Discovery
    // derives purely from shared card state, so every client in the call
    // sees the same set. Content renders locally; joining is opt-in below.
    for (const pt of callTilesState.tiles) {
      const m = getManifest(pt.pluginId);
      result.push({
        id: `plugin-${pt.pluginId}-${pt.cardId}`,
        label: m?.name ?? pt.pluginId,
        isLocal: false,
        kind: "plugin",
        videoTrack: null,
        peerId: `plugin:${pt.pluginId}`,
        pluginId: pt.pluginId,
        cardId: pt.cardId,
        pluginRoomCode: pt.roomCode,
        pluginViewers: pt.viewers,
      });
    }
    return result;
  });

  // What plugin tiles the user opted into (click-to-join, like shares).
  let joinedPluginTiles = $state(new Set<string>());

  // ── Persistent plugin layer ─────────────────────────────────────────────
  // A joined plugin tile's content (a YouTube iframe) cannot survive a
  // remount, and focusing moves tiles between DOM slots - so the content
  // mounts ONCE in a floating layer over the panel and only FOLLOWS the
  // placeholder tile's geometry. Clicks pass through the layer to the
  // placeholder (click-to-primary), except on the plugin's own controls,
  // which re-enable pointer events themselves.
  const _pluginAnchors = new Map<string, HTMLElement>();
  let pluginRects = $state<
    Record<string, { x: number; y: number; w: number; h: number } | null>
  >({});

  function pluginTileAnchor(node: HTMLElement, id: string) {
    _pluginAnchors.set(id, node);
    return {
      destroy() {
        if (_pluginAnchors.get(id) === node) _pluginAnchors.delete(id);
      },
    };
  }

  $effect(() => {
    if (joinedPluginTiles.size === 0 || !panelEl) {
      pluginRects = {};
      return;
    }
    let raf = 0;
    const measure = () => {
      const panel = panelEl?.getBoundingClientRect();
      if (panel) {
        const next: typeof pluginRects = {};
        for (const id of joinedPluginTiles) {
          const el = _pluginAnchors.get(id);
          if (el && el.isConnected) {
            const r = el.getBoundingClientRect();
            next[id] = {
              x: r.left - panel.left,
              y: r.top - panel.top,
              w: r.width,
              h: r.height,
            };
          } else {
            // Placeholder filtered out of the grid: hide the content but
            // keep it MOUNTED - the party's audio keeps playing.
            next[id] = null;
          }
        }
        // Shallow compare, not JSON.stringify: this runs every frame for
        // the whole call, and serializing two objects per frame is real
        // steady-state cost for a check that four number compares settle.
        const prev = pluginRects;
        const prevKeys = Object.keys(prev);
        const changed =
          prevKeys.length !== Object.keys(next).length ||
          prevKeys.some((k) => {
            const a = prev[k];
            const b = next[k];
            if (a === null || b === null) return a !== b;
            return (
              b === undefined ||
              a.x !== b.x ||
              a.y !== b.y ||
              a.w !== b.w ||
              a.h !== b.h
            );
          });
        if (changed) pluginRects = next;
      }
      raf = requestAnimationFrame(measure);
    };
    raf = requestAnimationFrame(measure);
    return () => cancelAnimationFrame(raf);
  });

  const joinedPluginTileData = $derived(
    tiles.filter((t) => t.kind === "plugin" && joinedPluginTiles.has(t.id))
  );

  // Joined ids whose card vanished (party closed, card replaced) would
  // otherwise accumulate for the life of the call and be measured every
  // frame above.
  $effect(() => {
    const live = new Set(
      tiles.filter((t) => t.kind === "plugin").map((t) => t.id)
    );
    if (![...joinedPluginTiles].some((id) => !live.has(id))) return;
    joinedPluginTiles = new Set(
      [...joinedPluginTiles].filter((id) => live.has(id))
    );
  });

  // The name tag paints ABOVE the plugin's own controls (it lives in the
  // placeholder, they live in the floating layer) and the two share the
  // tile's bottom edge. The tag cannot hover-hide itself - it is paint-only
  // and the controls are another subtree - so geometry decides: cursor in
  // the tile's bottom control zone means the tag steps aside.
  let panelMouse = $state<{ x: number; y: number } | null>(null);
  $effect(() => {
    const el = panelEl;
    if (!el) return;
    // rAF-coalesced: raw mousemove fires far above frame rate, and each
    // handler did a synchronous getBoundingClientRect (layout) plus a state
    // write re-evaluating chrome visibility - per EVENT, during a live call.
    let raf = 0;
    let pending: MouseEvent | null = null;
    const onMove = (e: MouseEvent) => {
      pending = e;
      if (raf) return;
      raf = requestAnimationFrame(() => {
        raf = 0;
        if (!pending) return;
        const r = el.getBoundingClientRect();
        panelMouse = { x: pending.clientX - r.left, y: pending.clientY - r.top };
        pending = null;
      });
    };
    const onLeave = () => {
      pending = null;
      panelMouse = null;
    };
    el.addEventListener("mousemove", onMove);
    el.addEventListener("mouseleave", onLeave);
    return () => {
      el.removeEventListener("mousemove", onMove);
      el.removeEventListener("mouseleave", onLeave);
      if (raf) cancelAnimationFrame(raf);
    };
  });

  /**
   * Is the cursor over this plugin tile?
   *
   * Geometry, not :hover, for the same reason pluginBadgeHidden is: the
   * plugin's content lives in a floating layer above the placeholder, and the
   * controls inside it re-enable pointer events. The moment the cursor
   * crosses one of those, the placeholder stops being hovered and any
   * group-hover chrome blinks out - right when the user is reaching for it.
   */
  function pluginTileHovered(id: string): boolean {
    const rect = pluginRects[id];
    const m = panelMouse;
    if (!rect || !m) return false;
    return (
      m.x >= rect.x &&
      m.x <= rect.x + rect.w &&
      m.y >= rect.y &&
      m.y <= rect.y + rect.h
    );
  }

  function pluginBadgeHidden(id: string): boolean {
    const rect = pluginRects[id];
    const m = panelMouse;
    if (!rect || !m) return false;
    return (
      m.x >= rect.x &&
      m.x <= rect.x + rect.w &&
      m.y >= rect.y + rect.h - 72 &&
      m.y <= rect.y + rect.h
    );
  }

  $effect(() => {
    // Rescan when the call room changes, when card state folds (votes,
    // queue changes), and when new cards land in the open room's view.
    void cardStateTickForPlugins;
    void transportState.messages.length;
    void refreshCallTiles(transportState.callRoomCode ?? null);
  });
  let cardStateTickForPlugins = $state(0);
  $effect(() => onCardStateChange(() => (cardStateTickForPlugins += 1)));

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

  // What the grid shows. "streaming" keeps anything worth watching - a camera
  // as much as a share - while "screens" narrows to shares alone, which is
  // what you want when someone is presenting and the cameras are noise.
  // Either filter falls back to everyone if its last match goes away, so the
  // panel never ends up empty.
  // Per-category visibility instead of one exclusive filter: with people,
  // screen shares AND app tiles all in the grid, "only X" radios stopped
  // composing. People keeps three levels (hiding non-streamers is its own
  // popular mode); shares and apps are plain toggles.
  type PeopleMode = "all" | "streaming" | "hidden";
  const gridView = $state({
    people: "all" as PeopleMode,
    screens: true,
    apps: true,
  });
  const gridViewActive = $derived(
    gridView.people !== "all" || !gridView.screens || !gridView.apps
  );
  const tileHasVideo = (t: TileData) =>
    t.videoTrack !== null ||
    (t.kind === "transmission" && !!t.isPending) ||
    t.kind === "plugin";
  const visibleTiles = $derived.by(() => {
    const kept = tiles.filter((t) => {
      if (t.kind === "plugin") return gridView.apps;
      if (t.kind === "screen" || t.kind === "transmission")
        return gridView.screens;
      if (gridView.people === "hidden") return false;
      if (gridView.people === "streaming") return t.videoTrack !== null;
      return true;
    });
    // Never an empty panel: a view that filters everything away shows
    // everyone instead, so there is always a way back to the menu.
    return kept.length ? kept : tiles;
  });

  // Container queries, not viewport ones: beside the chat the stage is a
  // narrow column inside a wide window.
  const gridCols = $derived.by(() => {
    const n = visibleTiles.length;
    if (n <= 1) return "grid-cols-1";
    if (n <= 3) return "grid-cols-1 @md:grid-cols-2";
    if (n <= 7) return "grid-cols-1 @xs:grid-cols-2 @xl:grid-cols-3";
    return "grid-cols-1 @xs:grid-cols-2 @xl:grid-cols-4";
  });

  const rowClass = $derived.by(() => {
    // ~20% more height without going fullscreen.
    if (watchingFocused) {
      return "h-[54vh]";
    }
    const n = visibleTiles.length;
    const cols = n <= 1 ? 1 : n <= 4 ? 2 : n <= 9 ? 3 : 4;
    const rows = Math.ceil(n / cols);
    return rows <= 1 ? "h-[35vh]" : "h-[45vh]";
  });

  // rowClass is viewport-height based and only means anything stacked. Beside
  // the chat the panel just fills its row.
  const panelSizeClass = $derived.by(() => {
    if (isFullscreen) return "h-screen";
    if (beside) return "min-h-0 flex-1";
    return `shrink-0 border-b border-border ${rowClass}`;
  });

  // ── Focus ─────────────────────────────────────────────────────────────────

  // Pin state is in callFocus store so it survives navigation away from the
  // call room. The stage reads callFocus.pinnedTileId to determine what to focus.
  const focusedTile = $derived(
    callFocus.pinnedTileId
      ? (visibleTiles.find((t) => t.id === callFocus.pinnedTileId) ?? null)
      : null
  );
  // A focused tile is being WATCHED, not glanced at - but only where the
  // focus visibly changes the layout. Stacked above the chat, the panel
  // grows (rowClass) and the controls go immersive like fullscreen
  // (dockedControls). BESIDE the chat the panel is already as big as it
  // gets: a pin there rearranges tiles but grows nothing, and controls that
  // vanished on a click that changed so little read as "watching a live
  // undocked my controls" - so beside stays docked, and fullscreen is the
  // immersive mode there. Cameras count like shares and app tiles: a
  // focused face is watched the same way a focused stream is.
  const watchingFocused = $derived(!!focusedTile && !beside);
  const showThumbnails = $derived(
    focusedTile ? focusedTile.kind !== "screen" : false
  );
  const thumbnailTiles = $derived(
    focusedTile && showThumbnails
      ? visibleTiles.filter((t) => t.id !== callFocus.pinnedTileId)
      : []
  );

  // Clear the pin if the pinned tile disappears (peer leaves, share ends).
  // This effect survives navigation away from the call room because the pin
  // is in the callFocus store, not this component.
  $effect(() => {
    autofocusEffect(tiles.map((t) => t.id));
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

  // Docked (visible, in reserved space below the tiles) unless immersive:
  // fullscreen, or the focused tall-panel view - there the controls (and
  // the fullscreen button, and plugin tile chrome, which all key off this)
  // fade after the idle timeout and return on mouse movement. Merely
  // watching a live in the grid, or focusing one beside the chat, keeps
  // the controls docked - see watchingFocused.
  const dockedControls = $derived(!isFullscreen && !watchingFocused);

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
  }

  async function toggleBrowserPiP(): Promise<void> {
    if (callPipPanel.browserPip) await exitBrowserPip();
    else await enterBrowserPip(() => {});
  }

  // ── Visibility conditions ─────────────────────────────────────────────────

  // Every avatar currently on screen gets its average colour resolved once.
  // Priming from an effect rather than from the template on demand: the
  // template runs during render, and seeding a cache there is a state write
  // mid-render.
  $effect(() => {
    // Off means no decode at all, not a decode whose result is thrown away.
    if (!displayPrefs.avatarTint) return;
    for (const t of tiles) if (t.avatarUrl) primeGlow(t.avatarUrl);
    for (const peerId of callPeerIds) {
      const avatar = getPeerAvatar(peerId);
      if (avatar) primeGlow(avatar);
    }
  });

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
  {@const isWatchedTx =
    tile.kind === "transmission" && watchingTransmissionPeerId === tile.peerId}
  {@const tileColor = getPeerColor(tile.peerId)}
  {#if tile.kind === "plugin" && joinedPluginTiles.has(tile.id)}
    <!-- A DIV, not the button every other tile is: the plugin renders its
         own interactive controls and interactive content nested in a button
         is both invalid and unusable. Clicking the tile itself behaves like
         every other tile - toggle primary - and the plugin's real controls
         stop propagation so they never trigger it. -->
    <div
      data-plugin-tile={tile.id}
      use:pluginTileAnchor={tile.id}
      role="button"
      tabindex={0}
      aria-label={isFocused ? "Minimize tile" : `Focus ${tile.label}`}
      onclick={() => {
        if (isOnlyOne) return;
        if (isFocused) onUnfocus();
        else onFocus();
      }}
      onkeydown={(e) => {
        if (e.key !== "Enter" && e.key !== " ") return;
        if (isOnlyOne) return;
        if (isFocused) onUnfocus();
        else onFocus();
      }}
      class="group relative flex cursor-pointer items-center justify-center overflow-hidden rounded-lg bg-black {isFocused
        ? 'w-full h-full'
        : ''} {compact ? 'aspect-video' : ''}"
    >
      <!-- Content lives in the persistent layer; this is only the anchor
           the layer follows, plus the chrome painted above it. -->
      <!-- "Leave", not "Stop watching": the same word for every plugin, and
           the mirror of the "Join {tile.label}" affordance this tile replaced.
           A plugin is not always something you watch - a party is something
           you are in. Hidden until the cursor is on the tile so it does not
           sit over the plugin's own content the whole call - except on a
           touch screen, where there is no cursor to reveal it with and a
           hidden control is simply an unreachable one. -->
      <Tip text="Leave {tile.label}">
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={(event) => {
              event.stopPropagation();
              joinedPluginTiles = new Set(
                [...joinedPluginTiles].filter((id) => id !== tile.id)
              );
            }}
            aria-label="Leave {tile.label}"
            class="absolute left-1.5 top-1.5 z-30 flex size-8 items-center justify-center rounded-lg bg-red-500/30 text-red-300 ring-1 ring-red-500/60 transition-opacity hover:bg-red-500/45 focus-visible:pointer-events-auto focus-visible:opacity-100 {isSmallScreen ||
            pluginTileHovered(tile.id)
              ? ''
              : 'pointer-events-none opacity-0'}"
          >
            <Radio class="size-4" />
          </button>
        {/snippet}
      </Tip>
      <div
        class="absolute bottom-1.5 left-1.5 z-30 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 pointer-events-none transition-opacity {pluginBadgeHidden(
          tile.id
        )
          ? 'opacity-0'
          : ''}"
      >
        <Puzzle class="size-3 text-white" />
        <span class="text-xs mt-0.75 leading-none text-white font-mono"
          >{tile.label}</span
        >
      </div>
      {#if tile.pluginViewers?.length}
        <!-- Same audience chip, same corner as transmissions. -->
        <Tip text={(tile.pluginViewers ?? []).join(", ")}>
          {#snippet children(props)}
            <div
              {...props}
              class="absolute top-1.5 right-1.5 z-30 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-mono text-white"
            >
              <Eye class="size-3" />
              {(tile.pluginViewers ?? []).length}
            </div>
          {/snippet}
        </Tip>
      {/if}
    </div>
  {:else if tile.kind === "plugin"}
    <!-- Not joined yet. The tile itself is inert - only the join button takes
         a click. As one big button, any stray click anywhere in the tile
         opted you into loading a plugin's content, which is the one thing
         opt-in exists to prevent. -->
    <div
      class="relative flex items-center justify-center overflow-hidden rounded-lg bg-muted/30 {isFocused
        ? 'w-full h-full'
        : ''} {compact ? 'aspect-video' : ''}"
    >
      {#if tile.pluginViewers?.length}
        <Tip text={(tile.pluginViewers ?? []).join(", ")}>
          {#snippet children(props)}
            <div
              {...props}
              class="absolute top-1.5 right-1.5 z-10 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-mono text-white"
            >
              <Eye class="size-3" />
              {(tile.pluginViewers ?? []).length}
            </div>
          {/snippet}
        </Tip>
      {/if}
      <div class="flex flex-col items-center gap-2">
        <PluginIcon
          icon={getManifest(tile.pluginId ?? "")?.icon ?? "lucide:unplug"}
          class="size-8 text-primary"
        />
        <button
          type="button"
          onclick={() => {
            joinedPluginTiles = new Set([...joinedPluginTiles, tile.id]);
          }}
          class="cursor-pointer rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs font-mono text-foreground shadow-sm transition-all hover:border-primary/50 hover:shadow-md"
        >
          Join {tile.label}
        </button>
      </div>
    </div>
  {:else}
  <!-- A wrapper so the "stop watching" control can sit BESIDE the tile rather
       than inside it. A button nested in a button is invalid HTML, which is
       what pushed this element to div role="button" - but that trades away
       focus handling, keyboard activation and assistive-technology semantics
       that a real button gives for free, on every tile in the call, to serve
       one overlay. The layout classes live on the wrapper; the button fills
       it. -->
  <div
    class="relative {isFocused ? 'w-full h-full' : ''} {compact
      ? 'aspect-video'
      : ''}"
  >
  <button
    type="button"
    oncontextmenu={(e) => openPeerMenu(e, tile)}
    class="group relative flex h-full w-full items-center justify-center overflow-hidden rounded-lg bg-muted/30 cursor-pointer transition-shadow duration-200
      {tile.connecting ? 'connecting-wave' : ''}
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
      {@const glow = displayPrefs.avatarTint ? glowFor(tile.avatarUrl) : null}
      {#if glow}
        <!-- The tile lit by the person in it. Both layers sit before the
             avatar in the DOM so the avatar paints over them. -->
        <div
          class="pointer-events-none absolute inset-0 transition-opacity duration-500"
          style={ambientStyle(glow)}
        ></div>
        <!-- Grain, and not only for the look: a wide radial gradient over a
             near-black tile bands into visible rings on an 8-bit display, and
             noise is what dithers it away. -->
        <div class="tile-grain pointer-events-none absolute inset-0"></div>
      {/if}
      <div
        class="relative flex items-center justify-center rounded-full {tile.isLocal
          ? 'bg-primary/20 text-primary'
          : 'bg-secondary text-secondary-foreground'} font-semibold overflow-hidden font-mono transition-[filter] duration-300
        {compact ? 'size-[2.66rem] text-sm' : 'size-[5.32rem] text-2xl'}"
        style="{tileColor ? `color: ${tileColor};` : ''}{rimStyle(
          glow,
          compact ? 0.5 : 1
        )}"
      >
        {#if tile.avatarUrl}
          <GifImage
            src={tile.avatarUrl}
            alt={tile.label}
            class="size-full object-cover"
            animate={speakers.speaking.has(tile.peerId)}
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
              class="absolute top-1.5 right-1.5 z-10 flex items-center gap-1 rounded bg-black/60 px-1.5 py-0.5 text-[11px] font-mono text-white"
            >
              <Eye class="size-3" />
              {tile.isLocal ? `${audience.count} watching` : audience.count}
            </div>
          {/snippet}
        </Tip>
      {/if}
    {/if}

    <!-- Pending transmission overlay - "Click to watch" -->
    {#if isPendingTx}
      <!-- pointer-events-none: the click target is the tile button itself,
           and this overlay was eating the audience badge's hover tooltip. -->
      <div
        class="pointer-events-none absolute inset-0 grid place-items-center bg-muted/30"
      >
        <div
          class="rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs font-mono text-foreground shadow-sm transition-all group-hover:border-primary/50 group-hover:shadow-md"
        >
          Watch {tile.label}'s screen
        </div>
      </div>
    {/if}

    <!-- Stalled overlay: getStats saw the consumer stop advancing. A track
         object is proof a consumer exists, not that RTP still arrives
         (sfu-audit finding 14) - this is the honest signal instead. -->
    {#if tile.stalled && hasVideo}
      <div
        class="pointer-events-none absolute inset-0 grid place-items-center bg-background/50"
      >
        <div
          class="flex items-center gap-1.5 rounded-full border border-border bg-background/95 px-3 py-1.5 text-xs font-mono text-foreground shadow-sm"
        >
          {#if tile.kind === "screen"}
            <MonitorOff class="size-3.5" />
          {:else}
            <CameraOff class="size-3.5" />
          {/if}
          Frozen - reconnecting
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
        <!-- Relayed badge on call tiles: always shown, not gated on showConnectionInfo.
             That setting controls only the floating panel on the right. -->
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
    {#if isWatchedTx}
      <!-- A SIBLING of the tile button, not a child: nesting it was what made
           the tile stop being a button in the first place. -->
      <button
        type="button"
        onclick={stopWatchingTransmission}
        aria-label="Stop watching"
        class="absolute top-1.5 left-1.5 z-20 flex size-8 items-center justify-center rounded-lg bg-red-500/30 text-red-300 ring-1 ring-red-500/60 hover:bg-red-500/45"
      >
        <Radio class="size-4" />
      </button>
    {/if}
  </div>
  {/if}
{/snippet}

{#if nobodyInCall}
  <!-- render nothing -->
{:else if othersInCallNotUs}
  <div
    class="flex flex-col relative pb-14 bg-background
      {beside
      ? 'min-h-0 flex-1'
      : 'h-[12vh] sm:h-[16vh] shrink-0 border-b border-border'}"
  >
    <div class="flex-1 flex items-center justify-center">
      <div class="flex flex-wrap items-center justify-center gap-1">
        {#each [...callPeerIds] as peerId (peerId)}
          {@const label = getPeerLabel(peerId)}
          {@const avatar = getPeerAvatar(peerId)}
          {@const state = callPeerStates.get(peerId)}
          {@const relayed = isRelayed(peerId)}
          <Tip text={label}>
            {#snippet children(props)}
          <div
            {...props}
            class="relative flex size-16 sm:size-20 items-center justify-center rounded-full bg-secondary text-2xl font-semibold text-secondary-foreground ring-2 ring-background font-mono transition-[filter] duration-300"
            style={rimStyle(displayPrefs.avatarTint ? glowFor(avatar) : null)}
          >
            {#if avatar}
              <!-- The image clips to the circle, not the container: with
                   overflow-hidden on the container the mute/deafen and relay
                   badges were shaved by the circle's edge. -->
              <GifImage
                src={avatar}
                alt={label}
                class="size-full rounded-full object-cover"
                animate={speakers.speaking.has(peerId)}
              />
            {:else}
              {label.charAt(0).toUpperCase()}
            {/if}
            <!-- Relayed badge on peer avatars in "others in call" view: always shown,
                 not gated on showConnectionInfo. That setting controls only the floating
                 panel on the right. -->
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
            {/snippet}
          </Tip>
        {/each}
      </div>
    </div>
    <div class="absolute bottom-3 left-1/2 -translate-x-1/2">
      <button
        type="button"
        onclick={joinCall}
        disabled={transportState.connecting || transportState.joiningCall}
        aria-busy={transportState.joiningCall}
        class:animate-pulse={transportState.joiningCall}
        class="group relative flex items-center gap-2 rounded-xl bg-primary px-5 py-2.5 text-sm font-semibold text-primary-foreground shadow-lg shadow-primary/30 transition-all duration-200 hover:bg-primary/90 hover:scale-105 hover:shadow-primary/50 disabled:opacity-60 disabled:hover:scale-100"
      >
        <Phone class="size-4" />
        {transportState.joiningCall
          ? "Joining..."
          : transportState.connecting
            ? "Connecting..."
            : "Join call"}
      </button>
    </div>
  </div>
{:else if inCall}
  <div
    bind:this={panelEl}
    role="group"
    aria-label="Call"
    oncontextmenu={openViewMenu}
    class="flex flex-col relative bg-background {panelSizeClass}"
  >
    <!-- Always-mounted remote audio elements -->
    {#each remoteAudio as a (a.id)}
      <!-- svelte-ignore a11y_media_has_caption -->
      <audio data-remote style="display:none" autoplay use:audioAction={a.track}
      ></audio>
    {/each}

    <!-- Tile area -->
    <div class="@container relative flex-1 min-h-0 overflow-hidden p-1.5">
      {#if focusedTile}
        <div class="flex h-full gap-1.5">
          <div class="flex-1 min-w-0">
            {@render callTile(
              focusedTile,
              true,
              focusedTile.kind === "camera" &&
                speakers.speaking.has(focusedTile.peerId),
              false,
              false,
              () => {},
              () => (callFocus.pinnedTileId = null)
            )}
          </div>
          {#if thumbnailTiles.length > 0}
            <div
              class="flex flex-col gap-1 overflow-y-auto w-20 @xl:w-28 shrink-0"
            >
              {#each thumbnailTiles as tile (tile.id)}
                {@render callTile(
                  tile,
                  false,
                  tile.kind === "camera" && speakers.speaking.has(tile.peerId),
                  false,
                  true,
                  () => (callFocus.pinnedTileId = tile.id),
                  () => (callFocus.pinnedTileId = null)
                )}
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <div class="grid h-full auto-rows-fr gap-1.5 {gridCols}">
          {#each visibleTiles as tile (tile.id)}
            {@render callTile(
              tile,
              false,
              tile.kind === "camera" && speakers.speaking.has(tile.peerId),
              tiles.length === 1,
              false,
              () => (callFocus.pinnedTileId = tile.id),
              () => (callFocus.pinnedTileId = null)
            )}
          {/each}
        </div>
      {/if}
    </div>

    <!-- Persistent plugin content layer: mounted once per joined tile,
         positioned over the placeholder wherever the layout puts it, so a
         focus change never remounts (and thus never reloads) an iframe.
         pointer-events-none lets clicks fall through to the placeholder;
         plugin controls re-enable their own. -->
    {#each joinedPluginTileData as pt (pt.id)}
      {@const rect = pluginRects[pt.id]}
      <div
        class="pointer-events-none absolute z-10 overflow-hidden rounded-lg"
        style={rect
          ? `left:${rect.x}px; top:${rect.y}px; width:${rect.w}px; height:${rect.h}px;`
          : "left:0; top:0; width:1px; height:1px; opacity:0;"}
      >
        <PluginCallTileView
          pluginId={pt.pluginId!}
          cardId={pt.cardId!}
          roomCode={pt.pluginRoomCode!}
          chromeVisible={dockedControls ? panelMouse !== null : controlsVisible}
        />
      </div>
    {/each}

    <!-- Call controls. Docked = a REAL flex row below the tiles, not an
         absolute bar floating over a padding band sized by guesswork: the
         band (pb-14) was shorter than the bar, so the controls always bled
         over the bottom tile row, and once the watching cluster (stop
         button + volume) widened the bar it sat squarely on top of the
         tiles - "undocked" in all but state. In flow, the tile area shrinks
         around whatever height the bar actually has. The immersive modes
         keep the floating overlay. -->
    <div
      role="group"
      aria-label="Call controls"
      class={cn(
        "transition-all duration-300 z-20",
        dockedControls
          ? cn(
              "relative shrink-0 py-2",
              // Small screens' inner layout is a full-width 3-column grid;
              // desktop is a shrink-to-fit cluster row that wants centering.
              isSmallScreen ? "w-full px-2" : "flex justify-center"
            )
          : cn(
              "absolute left-1/2 -translate-x-1/2",
              isSmallScreen ? "bottom-2 w-[calc(100%-1rem)] max-w-120" : "bottom-4",
              !controlsVisible &&
                "opacity-0 pointer-events-none translate-y-4"
            )
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
              <Tip text={muted ? "Unmute microphone" : "Mute microphone"}>
                {#snippet children(props)}
              <button
                {...props}
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
                {/snippet}
              </Tip>
              <Tip text={cameraOff ? "Turn on camera" : "Turn off camera"}>
                {#snippet children(props)}
              <button
                {...props}
                type="button"
                onclick={toggleCamera}
                disabled={transportState.cameraPending}
                aria-busy={transportState.cameraPending}
                class:animate-pulse={transportState.cameraPending}
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
                {/snippet}
              </Tip>
              <Tip text={screenSharing ? "Stop screen share" : "Share screen"}>
                {#snippet children(props)}
              <button
                {...props}
                type="button"
                onclick={toggleScreenShare}
                disabled={transportState.screenSharePending}
                aria-busy={transportState.screenSharePending}
                class:animate-pulse={transportState.screenSharePending}
                aria-label={screenSharing
                  ? "Stop screen share"
                  : "Share screen"}
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
                {/snippet}
              </Tip>
            </div>
          </div>

          <div class="flex justify-center">
            <Tip text="Leave call">
              {#snippet children(props)}
            <button
              {...props}
              type="button"
              onclick={leaveCall}
              aria-label="Leave call"
              class="group relative flex h-8 w-14 items-center justify-center rounded-lg bg-linear-to-br from-red-500 to-red-600 text-white shadow-lg shadow-red-500/30 transition-all duration-200 hover:from-red-400 hover:to-red-500"
            >
              <PhoneOff class="size-4" />
            </button>
              {/snippet}
            </Tip>
          </div>

          <div class="flex justify-end">
            {#if isWatchingTransmission}
              <div
                data-transmission-volume
                class="relative flex items-center gap-2 rounded-xl border border-white/10 bg-zinc-900/95 px-2 py-2"
              >
                <Tip text="Stop watching">
                  {#snippet children(props)}
                <button
                  {...props}
                  type="button"
                  onclick={stopWatchingTransmission}
                  aria-label="Stop watching"
                  class="flex h-8 w-8 items-center justify-center rounded-lg bg-red-500/20 text-red-400 transition-all duration-200 hover:bg-red-500/30 ring-1 ring-red-500/50"
                >
                  <Radio class="size-4" />
                </button>
                  {/snippet}
                </Tip>
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
        <div class="flex max-w-full flex-wrap items-center justify-center gap-4">
          <div
            class={cn(
              "flex gap-2",
              !dockedControls &&
                "bg-zinc-900/95 border border-white/10 rounded-xl p-3 py-2"
            )}
          >
            <Tip text={muted ? "Unmute microphone" : "Mute microphone"}>
              {#snippet children(props)}
            <button
              {...props}
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
              {/snippet}
            </Tip>
            <Tip text={cameraOff ? "Turn on camera" : "Turn off camera"}>
              {#snippet children(props)}
            <button
              {...props}
              type="button"
              onclick={toggleCamera}
              disabled={transportState.cameraPending}
              aria-busy={transportState.cameraPending}
              class:animate-pulse={transportState.cameraPending}
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
              {/snippet}
            </Tip>

            <Tip text={screenSharing ? "Stop screen share" : "Share screen"}>
              {#snippet children(props)}
            <button
              {...props}
              type="button"
              onclick={toggleScreenShare}
              disabled={transportState.screenSharePending}
              aria-busy={transportState.screenSharePending}
              class:animate-pulse={transportState.screenSharePending}
              aria-label={screenSharing
                ? "Stop screen share"
                : "Share screen"}
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
              {/snippet}
            </Tip>
          </div>

          <Tip text="Leave call">
            {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={leaveCall}
            aria-label="Leave call"
            class={cn(
              "group relative flex items-center justify-center rounded-lg bg-linear-to-br from-red-500 to-red-600 text-white shadow-lg shadow-red-500/30 transition-all duration-200 hover:from-red-400 hover:to-red-500 hover:scale-105 hover:shadow-red-500/50 shrink-0",
              "h-8 w-16 md:h-10 md:w-16"
            )}
          >
            <PhoneOff class="md:size-5 size-4" />
          </button>
            {/snippet}
          </Tip>

          {#if isWatchingTransmission}
            <div
              class="relative flex items-center gap-2 rounded-xl bg-zinc-900/95 border border-white/10 p-3 py-2"
            >
              <Tip text="Stop watching">
                {#snippet children(props)}
              <button
                {...props}
                type="button"
                onclick={stopWatchingTransmission}
                aria-label="Stop watching"
                class="flex h-8 w-8 md:h-10 md:w-10 items-center justify-center rounded-lg bg-red-500/20 text-red-400 transition-all duration-200 hover:bg-red-500/30 ring-1 ring-red-500/50"
              >
                <Radio class="size-4" />
              </button>
                {/snippet}
              </Tip>
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

    <!-- Same visibility rule as plugin tile chrome: these corner buttons sit
         OVER the video, so they only exist while the mouse is on the call
         section (windowed) or the fullscreen chrome is up. -->
    <div
      class={cn(
        "transition-all duration-300",
        !(dockedControls ? panelMouse !== null : controlsVisible) &&
          "opacity-0 pointer-events-none"
      )}
    >
    <!-- PiP and fullscreen buttons in the top corners -->
    <Tip text={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}>
      {#snippet children(props)}
    <!-- Worth showing only when it changes anything: some tile with
         video AND some tile without. It also stays up whenever a filter is
         active, so a filter picked from the menu always has a way out even
         once everyone is streaming. -->
    {#if gridViewActive || tiles.length > 1}
      <Tip text="Configure what the grid shows">
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={(e) => {
              // Without this the click bubbles to the panel's click-away
              // closeMenus and the menu dies the same instant it opens.
              e.stopPropagation();
              openViewMenu(e);
            }}
            oncontextmenu={(e) => {
              e.stopPropagation();
              openViewMenu(e);
            }}
            aria-label="Configure what the grid shows"
            class="absolute top-3 left-3 sm:top-4 sm:left-4 flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-lg bg-zinc-900 transition-all duration-200 hover:scale-105 z-20 {gridViewActive
              ? 'text-primary'
              : 'text-zinc-300'}"
          >
            <SlidersHorizontal class="size-4" />
          </button>
        {/snippet}
      </Tip>
    {/if}

    <!-- Browser PiP button. Clicking requests picture-in-picture on the panel's video element. -->
    <Tip text={callPipPanel.browserPip ? "Exit picture-in-picture" : "Picture-in-picture"}>
      {#snippet children(props)}
        <button
          {...props}
          type="button"
          onclick={toggleBrowserPiP}
          aria-label={callPipPanel.browserPip ? "Exit picture-in-picture" : "Picture-in-picture"}
          class="absolute top-3 right-12 sm:top-4 sm:right-12 flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-lg bg-zinc-900 text-zinc-300 transition-all duration-200 hover:bg-zinc-900 hover:scale-105 z-20 {callPipPanel.browserPip
            ? 'text-primary'
            : ''}"
        >
          <Tv2 class="size-4" />
        </button>
      {/snippet}
    </Tip>

    <button
      {...props}
      type="button"
      onclick={toggleFullscreen}
      aria-label={isFullscreen ? "Exit fullscreen" : "Enter fullscreen"}
      class="absolute top-3 right-3 sm:top-4 sm:right-4 flex h-8 w-8 sm:h-10 sm:w-10 items-center justify-center rounded-lg bg-zinc-900 text-zinc-300 transition-all duration-200 hover:bg-zinc-900 hover:scale-105 z-20"
    >
      {#if isFullscreen}
        <Minimize class="size-4" />
      {:else}
        <Maximize class="size-4" />
      {/if}
    </button>
      {/snippet}
    </Tip>
    </div>

    <!-- Both menus live inside the panel on purpose. The panel is the element
         handed to requestFullscreen, and only the fullscreen element's own
         subtree is painted - a menu rendered as its sibling exists in the DOM
         but is invisible for as long as the call is fullscreen, however high
         its z-index. -->
    {#if viewMenu}
      <!-- svelte-ignore a11y_click_events_have_key_events -->
      <div
        role="menu"
        tabindex="-1"
        class="fixed z-50 w-56 rounded-md border border-border bg-popover py-1 shadow-xl font-mono"
        style="top: {viewMenu.y}px; left: {viewMenu.x}px"
        onkeydown={() => {}}
        onclick={(e) => e.stopPropagation()}
        oncontextmenu={(e) => e.preventDefault()}
      >
        <p class="truncate px-3 pb-1 pt-0.5 text-xs text-muted-foreground">
          People
        </p>
        {#each [{ value: "all", label: "Everyone", icon: UsersIcon }, { value: "streaming", label: "Only streamers", icon: Radio }, { value: "hidden", label: "Hidden", icon: UserX }] as opt (opt.value)}
          <button
            type="button"
            role="menuitemradio"
            aria-checked={gridView.people === opt.value}
            class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted"
            onclick={() => (gridView.people = opt.value as PeopleMode)}
          >
            <opt.icon class="size-4 shrink-0" />
            <span class="flex-1 truncate text-left">{opt.label}</span>
            {#if gridView.people === opt.value}
              <Check class="size-3.5 shrink-0 text-primary" />
            {/if}
          </button>
        {/each}

        <div class="my-1 border-t border-border"></div>

        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={gridView.screens}
          class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted"
          onclick={() => (gridView.screens = !gridView.screens)}
        >
          <MonitorIcon class="size-4 shrink-0" />
          <span class="flex-1 truncate text-left">Screen shares</span>
          {#if gridView.screens}
            <Check class="size-3.5 shrink-0 text-primary" />
          {/if}
        </button>
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={gridView.apps}
          class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted"
          onclick={() => (gridView.apps = !gridView.apps)}
        >
          <Puzzle class="size-4 shrink-0" />
          <span class="flex-1 truncate text-left">Apps</span>
          {#if gridView.apps}
            <Check class="size-3.5 shrink-0 text-primary" />
          {/if}
        </button>
        <button
          type="button"
          role="menuitemcheckbox"
          aria-checked={displayPrefs.callPip}
          class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted"
          onclick={() => setCallPip(!displayPrefs.callPip)}
        >
          <Tv2 class="size-4 shrink-0" />
          <span class="flex-1 truncate text-left">Picture-in-picture</span>
          {#if displayPrefs.callPip}
            <Check class="size-3.5 shrink-0 text-primary" />
          {/if}
        </button>
        {#if !isSmallScreen}
          <div class="my-1 border-t border-border"></div>
          <p class="truncate px-3 pb-1 pt-0.5 text-xs text-muted-foreground">
            Layout
          </p>
          {#each [{ beside: false, label: "Chat below", icon: Rows2 }, { beside: true, label: "Chat beside", icon: Columns2 }] as opt (opt.label)}
            <button
              type="button"
              role="menuitemradio"
              aria-checked={displayPrefs.callChatBeside === opt.beside}
              class="flex w-full cursor-pointer items-center gap-2 px-3 py-1.5 text-sm hover:bg-muted"
              onclick={() => setCallChatBeside(opt.beside)}
            >
              <opt.icon class="size-4 shrink-0" />
              <span class="flex-1 truncate text-left">{opt.label}</span>
              {#if displayPrefs.callChatBeside === opt.beside}
                <Check class="size-3.5 shrink-0 text-primary" />
              {/if}
            </button>
          {/each}
        {/if}
      </div>
    {/if}

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
  </div>
{/if}

<svelte:window
  onclick={closeMenus}
  onkeydown={(e) => {
    if (e.key === "Escape") closeMenus();
  }}
/>

<style>
  /* Static film grain: one tiled SVG turbulence, desaturated so it is grain
     and not confetti, overlaid so it darkens and lightens rather than washing
     the tile grey. No animation - a call already has enough moving. */
  .tile-grain {
    background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='120' height='120'%3E%3Cfilter id='n'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.85' numOctaves='3' stitchTiles='stitch'/%3E%3CfeColorMatrix type='saturate' values='0'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23n)'/%3E%3C/svg%3E");
    opacity: 0.16;
    mix-blend-mode: overlay;
  }

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
