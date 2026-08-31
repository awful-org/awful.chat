<script lang="ts">
  import { Tip } from "$lib/components/ui/tooltip";
  import { QueryClient, QueryClientProvider } from "@tanstack/svelte-query";
  import { identityStore } from "$lib/identity/identity.svelte";
  import { setBadge } from "$lib/notify.svelte";
  import GifImage from "$lib/components/GifImage.svelte";
  import IdentitySetup from "$lib/components/IdentitySetup.svelte";
  import UnlockIdentity from "$lib/components/UnlockIdentity.svelte";
  import RoomCreateJoin from "$lib/components/RoomCreateJoin.svelte";
  import ChatView from "$lib/components/ChatView.svelte";
  import RoomSidebar from "$lib/components/RoomSidebar.svelte";
  import TransportStatus from "$lib/components/TransportStatus.svelte";
  import {
    transportState,
    joinRoom,
    leaveRoom,
    selfId,
    setRoomName,
    removeRoomCompletely,
    connect,
    peerIdToDid, resolveMentionDisplayName} from "$lib/transport/transport.svelte";
  import {
    roomsStore,
    loadRooms,
    saveRoom,
    refreshPhonebook,
    refreshDmRooms,
  } from "$lib/rooms.svelte";
  import { uiState } from "$lib/ui-state.svelte";
  import {
    getMessages,
    getLastMessage,
    getUnreadCount,
    getPeerProfile,
    markRoomSeen,
    putPhonebookEntry,
    requestPersistentStorage,
    type PhonebookEntry,
  } from "$lib/storage";
  import { MessageType } from "$lib/types/message";
  import { loadProfile } from "$lib/profile.svelte";
  import { displayPrefs, setSidebarCollapsed } from "$lib/display-prefs.svelte";
  import { consumeLatestSharedPayload } from "$lib/share-target";
  import { humanizeMentions } from "$lib/mentions";
  import ReloadPrompt from "./ReloadPrompt.svelte";
  import InstallPrompt from "./InstallPrompt.svelte";
  import CommandPalette from "./palette/CommandPalette.svelte";
  import SearchOverlay from "./SearchOverlay.svelte";
  import PluginConfirmModal from "./PluginConfirmModal.svelte";
  import { openSearch } from "$lib/search/ui.svelte";
  import type { PaletteHost } from "$lib/palette/host";
  import { Dialog } from "bits-ui";
  import { Notebook, Star, Trash2, Users, X } from "@lucide/svelte";
  import {
    Drawer,
    DrawerContent,
    DrawerHeader,
    DrawerTitle,
  } from "$lib/components/ui/drawer";
  import {
    addToPhonebook,
    closeDmPanel,
    dmConversationCodeFor,
    openDmConversation,
    removeDmConversation,
    removeFromPhonebook,
  } from "$lib/transport/dm.svelte";
  import FloatingDmPanel from "$lib/components/FloatingDmPanel.svelte";
  import CallPipPanel from "$lib/components/CallPipPanel.svelte";
  import { normalizeRoomCode } from "$lib/room-code";
  import { updateSpeakerTracks, stopAllSpeakers, resumeAudioContextOnVisibilityChange } from "$lib/speakers.svelte";
  import { callFocus } from "$lib/call-focus.svelte";
  import { speakers } from "$lib/speakers.svelte";
  import { spotlight } from "$lib/spotlight";
  import { callPipPanel } from "$lib/call-pip.svelte";
  import type { SpotlightTile } from "$lib/spotlight";
  import {
    spotlightStore,
    buildTilesWithTracking,
    trackStartTimes,
    createCanvasPlaceholder,
    setPipSource,
    enterBrowserPip,
    exitBrowserPip,
  } from "$lib/call-spotlight.svelte";
  import type { CallState } from "$lib/call-tiles";
  import { setOnPictureInPictureEnter } from "$lib/plugins/media-session";

  const queryClient = new QueryClient();

  function parseRoomCode(pathname: string): string | null {
    const m = pathname.match(/^\/r\/([^/]+)/);
    if (!m) return null;
    try {
      return normalizeRoomCode(decodeURIComponent(m[1]));
    } catch {
      return normalizeRoomCode(m[1]);
    }
  }

  /**
   * Generate preview text for a message in room/DM list.
   * Maps message types to renderable previews, mapping plugin cards to their
   * names and skipping plugin updates (non-renderable data messages).
   */
  function previewText(msg: { type: string; content: string }): string {
    if (msg.type === MessageType.File) return "[file]";
    if (msg.type === MessageType.PluginUpdate) return "(message)"; // Skip plugin updates
    if (msg.type === MessageType.PluginCard) {
      try {
        const payload = JSON.parse(msg.content);
        return `[${payload.pluginId}]`;
      } catch {
        return "[plugin]";
      }
    }
    return humanizeMentions(msg.content, resolveMentionDisplayName) || "(message)";
  }



  let pendingRoomCode = $state<string | null>(
    parseRoomCode(window.location.pathname)
  );

  let joiningRoom = $state(false);
  let bootstrapped = $state(false);

  // Not folded into the bootstrap effect below: that one is once-per-page,
  // while an intent stored DURING a lock must drain on the re-unlock too
  // (unlocking an already-focused tab fires no focus/SW event to catch it).
  $effect(() => {
    if (identityStore.isUnlocked) void drainNotifyIntents_();
  });

  $effect(() => {
    if (!identityStore.isUnlocked || bootstrapped) return;
    bootstrapped = true;
    connect();
    // Offline DMs deposited at the relay while we were away (opt-in).
    import("$lib/transport/mailbox.svelte")
      .then(({ startMailboxCollector }) => startMailboxCollector())
      .catch(() => {});
    // Persistence IS requested at every unlock, but a denial was silent -
    // and eviction on a denied origin is exactly how a phone loses its
    // identity. Say it out loud, once per page load. ($lib/storage is
    // already statically imported here; a dynamic import of it was a
    // synthetic no-op promise.)
    requestPersistentStorage()
      .then(async (granted) => {
        if (granted) return;
        const { _transport } = await import("$lib/transport/transport.svelte");
        _transport.announce({
          type: "app-warning",
          message:
            "Storage is not protected - the browser may clear this app's data (identity included) when space runs low. See Settings > Data.",
        });
      })
      .catch(() => {});
    // OS-launched backup files (file_handlers) park in launch-file.ts; the
    // restore flow in Settings > Data consumes them when opened.
    import("$lib/launch-file")
      .then(({ initLaunchQueue }) =>
        initLaunchQueue(() => {
          void import("$lib/transport/transport.svelte").then(
            ({ _transport }) =>
              _transport.announce({
                type: "app-warning",
                message:
                  "Backup file received - open Settings > Data to restore it.",
              })
          );
        })
      )
      .catch(() => {});
    const roomsReady = loadRooms();
    loadProfile();
    if (pendingRoomCode) {
      const code = pendingRoomCode;
      pendingRoomCode = null;
      joiningRoom = true;
      // Join only after the stored rooms are loaded: the join saves the room,
      // and racing loadRooms() could drop it from the sidebar mirror.
      roomsReady
        .catch(() => {})
        .then(() => handleJoin(code, ""))
        .finally(() => {
          joiningRoom = false;
        });
    }
  });

  $effect(() => {
    if (!identityStore.isUnlocked) return;
    consumeSharedIfPresent().catch(() => {});
  });

  // Speaker detection must run while in call, not just while the stage is mounted.
  // The stage unmounts when the user navigates away from the call room, but speaker
  // detection must continue for the floating panel to show who is speaking.
  $effect(() => {
    if (!transportState.inCall) {
      stopAllSpeakers();
      return;
    }
    // Update speaker tracks whenever call state changes.
    // Convert null to undefined for type compatibility.
    const participants = new Map(
      Array.from(transportState.participants).map(([peerId, p]) => [
        peerId,
        {
          audioTrack: p.audioTrack ?? undefined,
          videoTrack: p.videoTrack ?? undefined,
          screenTrack: p.screenTrack ?? undefined,
          screenAudioTrack: p.screenAudioTrack ?? undefined,
        },
      ])
    );
    updateSpeakerTracks(
      participants,
      transportState.muted,
      transportState.localMicStream,
      selfId()
    );
  });

  // Resume audio context when visibility changes (tab becomes active), and
  // close the PiP window the tab switch opened: the call is on screen again.
  if (typeof document !== "undefined") {
    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && transportState.inCall) {
        resumeAudioContextOnVisibilityChange();
        if (callPipPanel.browserPip) void exitBrowserPip();
      }
    });
  }

  let activeRoomCode = $state<string | null>(null);
  let activeRoomName = $state<string>("");
  let activeDmPeerId = $state<string | null>(null);
  let sidebarTab = $state<"rooms" | "users">("rooms");
  let dmPreviews = $state(new Map<string, { text: string; ts: number }>());
  let dmInbox = $state(
    new Map<
      string,
      {
        roomCode: string;
        peerId: string;
        nickname: string;
        avatarUrl: string | null;
        ts: number;
        text: string;
      }
    >()
  );
  let dmUnread = $state(new Map<string, number>());
  let dmBuildRun = 0;
  const dmUnreadTotal = $derived(
    [...dmUnread.values()].reduce((sum, n) => sum + n, 0)
  );

  // Tell the transport what is actually on screen; see uiRoomCode.
  $effect(() => {
    transportState.uiRoomCode = activeRoomCode;
  });

  // Mirror everything unread onto the installed app icon and the tab title,
  // so a background tab shows "(3) Awful.chat" at a glance.
  //
  // Summed over the rooms that exist, not over every key in the map: summing
  // the map wholesale meant any entry that was not a room inflated the title
  // while the sidebar, which walks the room list, stayed right - and the two
  // numbers disagreeing is the bug the reader actually notices.
  $effect(() => {
    const rooms = roomsStore.rooms.reduce(
      (sum, room) => sum + (roomsStore.unreadCounts.get(room.roomCode) ?? 0),
      0
    );
    const total = rooms + dmUnreadTotal;
    setBadge(total);
    if (typeof document !== "undefined") {
      document.title = total > 0 ? `(${total}) Awful.chat` : "Awful.chat";
    }
  });
  const dmLatestByPeer = $derived.by(() => {
    const byPeer = new Map<
      string,
      typeof dmInbox extends Map<any, infer V> ? V : never
    >();
    for (const entry of dmInbox.values()) {
      const current = byPeer.get(entry.peerId);
      if (!current || entry.ts > current.ts) byPeer.set(entry.peerId, entry);
    }
    return byPeer;
  });
  const dmUnreadByPeer = $derived.by(() => {
    const byPeer = new Map<string, number>();
    for (const [roomCode, count] of dmUnread) {
      const entry = dmInbox.get(roomCode);
      if (!entry) continue;
      byPeer.set(entry.peerId, (byPeer.get(entry.peerId) ?? 0) + count);
    }
    return byPeer;
  });
  let lockedView = $state<"unlock" | "restore">("unlock");
  let sidebarOpen = $state(false);
  let joinError = $state<string | null>(null);
  let createJoinOpen = $state(false);
  let phonebookOpen = $state(false);
  let isMobile = $state(false);
  let incomingSharedFiles = $state<File[]>([]);
  let incomingSharedText = $state("");

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

  async function consumeSharedIfPresent() {
    const payload = await consumeLatestSharedPayload();
    if (!payload) return;
    incomingSharedFiles = payload.files;
    incomingSharedText = payload.text ?? payload.url ?? "";
    history.replaceState({}, "", "/app");
  }

  async function handleJoin(
    roomCode: string,
    _displayName: string,
    roomName?: string
  ) {
    joinError = null;
    try {
      if (!(await joinRoom(roomCode))) return;
      const known =
        roomName || roomsStore.rooms.find((r) => r.roomCode === roomCode)?.name;
      const label = known || roomCode;
      activeRoomCode = roomCode;
      activeRoomName = label;
      activeDmPeerId = null;
      sidebarTab = "rooms";
      if (known) {
        // Only announce a name we actually have. Joining from a bare invite
        // link used to broadcast the room code as the name and overwrite it
        // for everyone already in the room.
        setRoomName(known);
      } else {
        transportState.roomName = label;
      }
      await saveRoom(roomCode, label);
      history.pushState({ roomCode }, "", `/r/${roomCode}`);
    } catch (err) {
      joinError = err instanceof Error ? err.message : String(err);
    }
  }

  function handleLeave() {
    leaveRoom();
    activeRoomCode = null;
    activeRoomName = "";
    activeDmPeerId = null;
    history.pushState({}, "", "/app");
  }

  async function handleCloseDmView() {
    activeRoomCode = null;
    activeRoomName = "";
    activeDmPeerId = null;
    transportState.chatMode = "room";
    transportState.activeDmPeerId = null;
    transportState.roomName = "";
    await refreshDmRooms();
    history.pushState({}, "", "/app");
  }

  async function handleRemoveRoom(code?: string) {
    if (!code) code = activeRoomCode!;
    await removeRoomCompletely(code);
    if (activeRoomCode === code) {
      handleLeave();
    }
  }

  // What the user did on a NOTIFICATION - clicked it, or typed an inline
  // reply on Android - lands here. The service worker wrote the intent to
  // IndexedDB (the app may have been closed or locked at the time); this
  // drains it: navigate to the conversation, and send the reply through the
  // exact same path the composer uses.
  let drainingIntents = false;
  async function drainNotifyIntents_() {
    if (drainingIntents || !identityStore.isUnlocked) return;
    drainingIntents = true;
    try {
      const { drainNotifyIntents } = await import("$lib/notify-intents");
      const intents = await drainNotifyIntents();
      for (const it of intents) {
        if (it.dmPeerDid) await handleSelectDm(it.dmPeerDid);
        else await handleSelectRoom(it.roomCode);
        if (it.kind === "reply" && it.text.trim()) {
          const { sendMessage } = await import(
            "$lib/transport/transport.svelte"
          );
          // sendMessage targets whatever conversation is ACTIVE, and the
          // select above can be superseded (the user clicked elsewhere
          // mid-drain, or the DM open lost a race and returned early).
          // Verify the active conversation IS the intent's target before
          // sending - a reply must never land in the wrong chat.
          const activeDmDid =
            peerIdToDid(transportState.activeDmPeerId ?? "") ||
            transportState.activeDmPeerId;
          const onTarget = it.dmPeerDid
            ? transportState.chatMode === "dm" && activeDmDid === it.dmPeerDid
            : transportState.chatMode !== "dm" &&
              transportState.roomCode === it.roomCode;
          if (!onTarget) {
            console.warn("[notify] reply skipped: conversation changed");
            continue;
          }
          await sendMessage(it.text.trim());
        }
      }
    } catch (err) {
      console.warn("[notify] intent drain failed:", err);
    } finally {
      drainingIntents = false;
    }
  }

  $effect(() => {
    if (typeof navigator === "undefined" || !navigator.serviceWorker) return;
    const onMsg = (e: MessageEvent) => {
      if (e.data?.type === "notify-intent") void drainNotifyIntents_();
    };
    const onFocus = () => void drainNotifyIntents_();
    navigator.serviceWorker.addEventListener("message", onMsg);
    window.addEventListener("focus", onFocus);
    return () => {
      navigator.serviceWorker.removeEventListener("message", onMsg);
      window.removeEventListener("focus", onFocus);
    };
  });

  async function handleSelectRoom(code: string) {
    const room = roomsStore.rooms.find((r) => r.roomCode === code);
    // Always go through the token-claiming join, even for the room already
    // on screen: the fast paths skipped the claim, so a second quick click
    // during an in-flight switch either no-opped or wrote view state that
    // the losing join later contradicted. Last click wins, by construction.
    await handleJoin(code, "", room?.name);
    activeDmPeerId = null;
    sidebarTab = "rooms";
    sidebarOpen = false;
  }

  /**
   * Take the user back to the call they are in. The call survives navigating
   * away - only the stage unmounts, because it is gated on the conversation on
   * screen being the call's - so getting back is pure navigation. Nothing is
   * rejoined.
   */
  async function returnToCall(): Promise<void> {
    const code = transportState.callRoomCode;
    if (!code) return;
    if (code.startsWith("dm-")) {
      const peer = roomsStore.dmRooms.find(
        (r) => r.roomCode === code
      )?.participantDid;
      if (peer) await handleSelectDm(peer);
      return;
    }
    await handleSelectRoom(code);
  }

  $effect(() => {
    if (!uiState.returnToCallRequested) return;
    uiState.returnToCallRequested = false;
    void returnToCall();
  });

  // First half of a jump-to-message: get the right conversation on screen.
  // ChatView does the scrolling and clears the request - not here, or the
  // scroll target would be gone before the history rendered.
  $effect(() => {
    const jump = uiState.jumpToMessage;
    if (!jump || transportState.roomCode === jump.roomCode) return;
    if (jump.roomCode.startsWith("dm-")) {
      const peer = roomsStore.dmRooms.find(
        (r) => r.roomCode === jump.roomCode
      )?.participantDid;
      if (peer) void handleSelectDm(peer);
      else uiState.jumpToMessage = null;
      return;
    }
    void handleSelectRoom(jump.roomCode);
  });

  /**
   * Promote the floating panel's conversation to the full DMs view. The panel
   * closes: leaving it open over the same conversation would show it twice.
   */
  async function expandDmPanel(peerId: string): Promise<void> {
    closeDmPanel();
    await handleSelectDm(peerId);
  }

  function dmTitleFor(peerId: string): string {
    const did = peerIdToDid(peerId);
    return (
      roomsStore.phonebook.find(
        (p) => p.peerId === peerId || p.did === peerId
      )?.nickname ||
      transportState.peerNames.get(did) ||
      transportState.peerNames.get(peerId) ||
      dmLatestByPeer.get(peerId)?.nickname ||
      peerId.slice(0, 12)
    );
  }

  async function handleSelectDm(peerId: string) {
    // A superseded open (user clicked something else meanwhile) must not
    // write view state for the conversation it lost.
    if (!(await openDmConversation(peerId))) return;
    const resolvedPeerId = transportState.activeDmPeerId;
    if (!resolvedPeerId) return;
    // Normalize to DID since dmInbox uses participantDid which is always a DID
    const normalizedPeerId = peerIdToDid(resolvedPeerId) || resolvedPeerId;
    // After openDmConversation, the roomCode is set in transportState
    activeRoomCode =
      transportState.roomCode ??
      dmLatestByPeer.get(normalizedPeerId)?.roomCode ??
      (await dmConversationCodeFor(normalizedPeerId));
    activeRoomName = dmTitleFor(normalizedPeerId);
    transportState.roomName = activeRoomName;
    activeDmPeerId = normalizedPeerId;
    sidebarTab = "users";
    sidebarOpen = false;
    history.pushState({}, "", "/app");
    await refreshDmRooms();
    const dmCode = activeRoomCode;
    if (!dmCode) return;
    const latest = await getLastMessage(dmCode);
    if (latest && activeRoomCode === dmCode) {
      await markSeenForDm(dmCode, latest.lamport);
    }
  }

  async function markSeenForDm(
    roomCode: string,
    lamport: number
  ): Promise<void> {
    await markRoomSeen(roomCode, lamport);
    const next = new Map(dmUnread);
    next.set(roomCode, 0);
    dmUnread = next;
    const dmRoomIndex = roomsStore.dmRooms.findIndex(
      (r) => r.roomCode === roomCode
    );
    if (dmRoomIndex !== -1) {
      roomsStore.dmRooms[dmRoomIndex] = {
        ...roomsStore.dmRooms[dmRoomIndex],
        lastSeenLamport: Math.max(
          roomsStore.dmRooms[dmRoomIndex].lastSeenLamport ?? 0,
          lamport
        ),
      };
    }
    transportState.dmVersion += 1;
  }

  async function handleRemoveDm(peerId: string) {
    if (activeDmPeerId === peerId && isDmActive) {
      await handleCloseDmView();
    }
    await removeDmConversation(peerId);
    await refreshPhonebook();
    await refreshDmRooms();
    dmPreviews.delete(peerId);
    dmPreviews = new Map(dmPreviews);
    const nextInbox = new Map(dmInbox);
    for (const [roomCode, entry] of dmInbox) {
      if (entry.peerId === peerId) nextInbox.delete(roomCode);
    }
    dmInbox = nextInbox;
    const nextUnread = new Map(dmUnread);
    for (const [roomCode, entry] of dmInbox) {
      if (entry.peerId === peerId) nextUnread.delete(roomCode);
    }
    dmUnread = nextUnread;
    if (activeDmPeerId === peerId) {
      activeDmPeerId = null;
      activeRoomCode = null;
      activeRoomName = "";
      transportState.roomName = "";
    }
  }

  async function handleAddToPhonebook(peerId: string) {
    await addToPhonebook(peerId);
    await refreshPhonebook();
    await refreshDmRooms();
  }

  async function handleRemoveFromPhonebook(peerId: string) {
    await removeFromPhonebook(peerId);
    await refreshPhonebook();
    await refreshDmRooms();
  }

  function openCreateJoin() {
    createJoinOpen = true;
  }

  let paletteOpen = $state(false);

  // Anything outside this tree asks for the palette through uiState, the same
  // way it asks for the settings dialog.
  $effect(() => {
    if (!uiState.paletteOpenRequested) return;
    uiState.paletteOpenRequested = false;
    if (identityStore.isUnlocked) paletteOpen = true;
  });

  // Manage the spotlight state: build tiles, calculate spotlight, and manage video.
  // This is the single source of truth for both the in-app panel and browser PiP.

  // Ticking clock: updates every 250ms while in call.
  let tickingNow = $state(0);
  let clockInterval: ReturnType<typeof setInterval> | null = null;

  $effect(() => {
    if (!transportState.inCall) {
      if (clockInterval) {
        clearInterval(clockInterval);
        clockInterval = null;
      }
      return;
    }
    if (!clockInterval) {
      tickingNow = performance.now();
      clockInterval = setInterval(() => {
        tickingNow = performance.now();
      }, 250);
    }
    return () => {
      if (clockInterval) {
        clearInterval(clockInterval);
        clockInterval = null;
      }
    };
  });

  // Previous spotlight ID, for fallback (rule 4).
  let spotlightPrevious = $state<string | null>(null);

  // Build tiles with the unified builder and track start times.
  const tiles = $derived.by<SpotlightTile[]>(() => {
    const id = selfId();
    const callState: CallState = {
      participants: transportState.participants,
      localCameraStream: transportState.localCameraStream,
      localScreenStream: transportState.localScreenStream,
      cameraOff: transportState.cameraOff,
      watchingTransmissionPeerId: transportState.watchingTransmissionPeerId,
      watchingTransmissionProducerId: transportState.watchingTransmissionProducerId,
      selfId: id,
      trackStartTimes,
    };
    return buildTilesWithTracking(callState);
  });

  // Calculate spotlight.
  const spotlightTileId = $derived(
    spotlight(
      tiles,
      callFocus.pinnedTileId,
      transportState.watchingTransmissionPeerId,
      speakers,
      spotlightPrevious,
      tickingNow
    )
  );

  const spotlightTile = $derived(tiles.find((t) => t.id === spotlightTileId));

  // Update the previous spotlight when it changes.
  $effect(() => {
    spotlightPrevious = spotlightTileId;
  });

  // Update the public spotlight store for the panel and PiP to read.
  $effect(() => {
    spotlightStore.tiles = tiles;
    spotlightStore.spotlightTileId = spotlightTileId;
    spotlightStore.spotlightTile = spotlightTile ?? null;
  });

  // Bind the PiP video element to the spotlight track.
  let pipVideoElement: HTMLVideoElement | null = $state(null);
  $effect(() => {
    spotlightStore.pipVideoElement = pipVideoElement;
  });

  // Update both the PiP video and the panel's video on spotlight change.
  // The spec constraint is: "a spotlight change must swap srcObject on ONE
  // element, never remount". We update both elements' srcObject but don't
  // remount either. This keeps browser PiP following along and keeps the
  // panel displaying the spotlight.
  // Keyed on the TRACK and the tile id, not the tile object: tiles are
  // rebuilt whenever participants change, and assigning a fresh MediaStream
  // to a <video> restarts it (a black frame each time). The stream is kept
  // and only replaced when what it carries actually changes.
  const spotlightTrack = $derived(spotlightTile?.videoTrack ?? null);
  const spotlightKey = $derived(
    spotlightTile ? `${spotlightTile.id}:${spotlightTrack?.id ?? "avatar"}` : null
  );
  const spotlightFit = $derived(
    spotlightTile?.kind === "camera" ? "cover" : "contain"
  );
  let spotlightStream: MediaStream | null = null;
  let spotlightStreamKey: string | null = null;
  $effect(() => {
    if (!pipVideoElement) return;
    const panelVideoElement = spotlightStore.panelVideoElement;
    const tile = spotlightTile;
    if (spotlightKey !== spotlightStreamKey) {
      spotlightStreamKey = spotlightKey;
      if (spotlightTrack) {
        spotlightStream = new MediaStream([spotlightTrack]);
      } else if (tile) {
        // No video: a still of the avatar, drawn once per spotlight change.
        const label =
          transportState.peerNames.get(
            peerIdToDid(tile.peerId) || tile.peerId
          ) ?? tile.peerId.slice(0, 8);
        spotlightStream = createCanvasPlaceholder(label, label.charAt(0));
      } else {
        spotlightStream = null;
      }
    }
    for (const el of [pipVideoElement, panelVideoElement]) {
      if (!el) continue;
      if (el.srcObject !== spotlightStream) el.srcObject = spotlightStream;
      el.style.objectFit = spotlightFit;
    }
    const label = tile
      ? (transportState.peerNames.get(peerIdToDid(tile.peerId) || tile.peerId) ??
        tile.peerId.slice(0, 8))
      : "";
    setPipSource(spotlightStream, label, spotlightFit);
  });

  // Wire up browser PiP event handlers on the video element.
  $effect(() => {
    if (!pipVideoElement) return;
    const onEnter = () => {
      callPipPanel.browserPip = true;
    };
    const onLeave = () => {
      callPipPanel.browserPip = false;
    };
    pipVideoElement.addEventListener("enterpictureinpicture", onEnter);
    pipVideoElement.addEventListener("leavepictureinpicture", onLeave);
    return () => {
      pipVideoElement?.removeEventListener("enterpictureinpicture", onEnter);
      pipVideoElement?.removeEventListener("leavepictureinpicture", onLeave);
    };
  });

  // Wire up Media Session auto-PiP handler (for Chromium tab switch).
  // When the browser's Media Session initiates PiP, this handler is called.
  $effect(() => {
    if (!transportState.inCall || !pipVideoElement || !displayPrefs.callPip) {
      setOnPictureInPictureEnter(null);
      return;
    }

    const handler = async () => {
      // Nothing to see in a voice-only call: an avatar floating over another
      // tab is noise, not a call. The user can still open it by hand.
      if (!spotlightTrack) return;
      await enterBrowserPip(() => void returnToCall());
    };

    setOnPictureInPictureEnter(handler);
  });

  // The palette cannot navigate on its own: this component owns activeRoomCode,
  // the history push, and the room-name broadcast. Reproducing that inside the
  // palette would fork the join path, so it delegates back here.
  //
  // activeRoomCode is a getter, not a snapshot, or the palette would read a
  // stale room for the whole time it is mounted.
  const paletteHost: PaletteHost = {
    get activeRoomCode() {
      return activeRoomCode;
    },
    openRoom: (code) => void handleSelectRoom(code),
    joinRoomByCode: (code) => void handleJoin(code, ""),
    openDm: (peerId) => void handleSelectDm(peerId),
    leaveRoom: handleLeave,
    removeRoom: (code) => void handleRemoveRoom(code),
    openCreateJoin,
  };

  // Manifest shortcut: long-press the installed icon > "New room".
  // The param is stripped so a later reload does not reopen the dialog.
  $effect(() => {
    if (!identityStore.isUnlocked) return;
    const params = new URLSearchParams(window.location.search);
    if (params.get("new") !== "1") return;
    createJoinOpen = true;
    params.delete("new");
    const query = params.toString();
    history.replaceState(
      {},
      "",
      window.location.pathname + (query ? `?${query}` : "")
    );
  });

  async function handleJoinFromModal(
    roomCode: string,
    displayName: string,
    roomName?: string
  ) {
    await handleJoin(roomCode, displayName, roomName);
    createJoinOpen = false;
    sidebarOpen = false;
  }

  function clearIncomingShared() {
    incomingSharedFiles = [];
    incomingSharedText = "";
  }

  function handlePopState() {
    const code = parseRoomCode(window.location.pathname);
    // The URL is the truth: even if the view already names this room, the
    // transport can be elsewhere (a DM opened underneath) - re-join then.
    if (code && (code !== activeRoomCode || transportState.roomCode !== code)) {
      const room = roomsStore.rooms.find((r) => r.roomCode === code);
      handleJoin(code, "", room?.name);
    } else if (!code && activeRoomCode) {
      activeRoomCode = null;
      activeRoomName = "";
      activeDmPeerId = null;
      transportState.chatMode = "room";
      transportState.activeDmPeerId = null;
      transportState.roomName = "";
    }
  }

  const myId = $derived(selfId());
  const hasSidebar = $derived(roomsStore.rooms.length > 0);
  const isDmActive = $derived(transportState.chatMode === "dm");
  const dmEntries = $derived.by(() => {
    const map = new Map<
      string,
      {
        peerId: string;
        nickname: string;
        avatarUrl?: string | null;
        addedAt: number;
        inPhonebook: boolean;
      }
    >();
    // Keyed by every identity form: dmInbox keys are DIDs while entries may
    // be keyed by peerId (or the reverse), and a one-form map made saved
    // contacts look unsaved here.
    const phonebookByPeer = new Map<string, PhonebookEntry>();
    for (const p of roomsStore.phonebook) {
      phonebookByPeer.set(p.peerId, p);
      if (p.did) phonebookByPeer.set(p.did, p);
      const mapped = peerIdToDid(p.peerId);
      if (mapped) phonebookByPeer.set(mapped, p);
    }
    for (const [_, data] of dmInbox) {
      const peerId = data.peerId;
      const pb = phonebookByPeer.get(peerId);
      const did = peerIdToDid(peerId);
      if (!map.has(peerId)) {
        map.set(peerId, {
          peerId,
          nickname:
            transportState.peerNames.get(did) ||
            transportState.peerNames.get(peerId) ||
            pb?.nickname ||
            data.nickname,
          avatarUrl:
            transportState.peerAvatars.get(did) ||
            transportState.peerAvatars.get(peerId) ||
            data.avatarUrl,
          addedAt: data.ts,
          inPhonebook: !!pb,
        });
      }
      // Keep the newest: this used to fill a gap only when nothing was set
      // yet, which pinned the preview to whichever message happened to land
      // first and never moved it again.
      const seen = dmPreviews.get(peerId);
      if (data.text && (!seen || data.ts >= seen.ts)) {
        dmPreviews.set(peerId, { text: data.text, ts: data.ts });
      }
    }
    return [...map.values()].sort((a, b) => {
      const aFav = !!phonebookByPeer.get(a.peerId)?.favorite;
      const bFav = !!phonebookByPeer.get(b.peerId)?.favorite;
      if (aFav !== bFav) return aFav ? -1 : 1;
      return b.addedAt - a.addedAt;
    });
  });

  async function toggleFavorite(peerId: string) {
    const existing = roomsStore.phonebook.find((p) => p.peerId === peerId);
    if (!existing) return;
    await putPhonebookEntry({ ...existing, favorite: !existing.favorite });
    await refreshPhonebook();
  }

  /** User-picked nickname color for a contact row, if the peer has one. */
  function colorForPeer(peerId: string): string | undefined {
    if (!displayPrefs.showPeerNicknameColors) return undefined;
    const did = peerIdToDid(peerId);
    return (
      transportState.peerColors.get(peerId) ??
      (did ? transportState.peerColors.get(did) : undefined)
    );
  }

  async function removePhonebookContact(peerId: string) {
    await removeFromPhonebook(peerId);
    await refreshPhonebook();
  }

  const sortedPhonebook = $derived.by(() => {
    return [...roomsStore.phonebook]
      .map((entry) => {
        const did = entry.did || peerIdToDid(entry.peerId);
        return {
          ...entry,
          did,
          nickname:
            transportState.peerNames.get(did) ||
            transportState.peerNames.get(entry.peerId) ||
            dmInbox.get(entry.peerId)?.nickname ||
            entry.nickname,
          avatarUrl:
            transportState.peerAvatars.get(did) ||
            transportState.peerAvatars.get(entry.peerId) ||
            dmInbox.get(entry.peerId)?.avatarUrl ||
            null,
        };
      })
      .sort((a, b) => {
        const favDiff = Number(!!b.favorite) - Number(!!a.favorite);
        if (favDiff !== 0) return favDiff;
        return a.nickname.localeCompare(b.nickname);
      });
  });

  $effect(() => {
    if (!identityStore.isUnlocked) return;
    refreshPhonebook().catch(() => {});
    refreshDmRooms().catch(() => {});
  });

  $effect(() => {
    roomsStore.dmRooms.length;
    // dmVersion bumps once per DM change; depending on messages.length would
    // re-run this storage sweep for every message in every room. The maps are
    // replaced wholesale on update, so identity also catches renames that
    // .size missed.
    transportState.dmVersion;
    transportState.peerNames;
    transportState.peerAvatars;
    (async () => {
      const run = ++dmBuildRun;
      const next = new Map<string, { text: string; ts: number }>();
      const nextInbox = new Map<
        string,
        {
          roomCode: string;
          peerId: string;
          nickname: string;
          avatarUrl: string | null;
          ts: number;
          text: string;
        }
      >();
      const unreadNext = new Map<string, number>();

      for (const room of roomsStore.dmRooms) {
        const peerId = room.participantDid;
        if (!peerId) continue;

        const did = peerIdToDid(peerId);
        // The preview only needs the newest message; loading a full page per
        // room made every keystroke in any conversation a storage sweep.
        let last = await getLastMessage(room.roomCode);

        const activeDid = peerIdToDid(transportState.activeDmPeerId ?? "");
        const roomDid = peerIdToDid(peerId);
        if (transportState.chatMode === "dm" && activeDid === roomDid) {
          const live = transportState.messages.filter(
            (m) => m.roomCode === room.roomCode
          );
          last = live[live.length - 1] ?? last;
        }

        const profile = await getPeerProfile(did).catch(() => undefined);
        // In a DM the only remote sender is the peer, so the newest message
        // carries their DID whenever they spoke last.
        const messageDid =
          last && last.senderId !== selfId() && last.senderName !== "You"
            ? last.senderId
            : undefined;
        const messageProfile = messageDid
          ? await getPeerProfile(messageDid).catch(() => undefined)
          : undefined;

        const nickname =
          messageProfile?.nickname ||
          transportState.peerNames.get(did) ||
          transportState.peerNames.get(peerId) ||
          profile?.nickname ||
          peerId.slice(0, 12);
        const avatarUrl =
          messageProfile?.pfpURL ||
          transportState.peerAvatars.get(did) ||
          transportState.peerAvatars.get(peerId) ||
          profile?.pfpURL ||
          null;

        // A DM room is created as soon as somebody is added to the phonebook,
        // so listing every room turned the DMs tab into a copy of the contact
        // list. Only conversations that have been spoken in belong here; the
        // rest are reachable through the phonebook.
        if (!last) continue;

        nextInbox.set(room.roomCode, {
          roomCode: room.roomCode,
          peerId,
          nickname,
          avatarUrl,
          ts: last.timestamp,
          text: previewText(last),
        });

        if (last) {
          next.set(peerId, {
            text: previewText(last),
            ts: last.timestamp,
          });
        }

        const self = selfId();
        const unread = await getUnreadCount(
          room.roomCode,
          room.lastSeenLamport,
          self
        );
        unreadNext.set(room.roomCode, unread);
      }

      if (run !== dmBuildRun) return;
      dmPreviews = next;
      dmInbox = nextInbox;
      dmUnread = unreadNext;
    })().catch(() => {});
  });
</script>

<svelte:window
  onpopstate={handlePopState}
  onkeydown={(e) => {
    if (!(e.metaKey || e.ctrlKey) || e.altKey) return;

    // Cmd/Ctrl+F searches the open room (all rooms with Shift, or when no
    // room is open). It shadows the browser's find on purpose: the page
    // only ever holds one page of history, so native find searches almost
    // nothing.
    if (e.key.toLowerCase() === "f") {
      e.preventDefault();
      if (!identityStore.isUnlocked) return;
      openSearch(
        e.shiftKey || !transportState.roomCode ? null : transportState.roomCode
      );
      return;
    }

    if (e.shiftKey) return;
    const key = e.key.toLowerCase();

    // Cmd/Ctrl+K opens the command palette. preventDefault is required even
    // though nothing here claims the key: Firefox maps it to the search bar.
    // Stays enabled on mobile, unlike the sidebar shortcut, because an external
    // keyboard is the whole point of it.
    if (key === "k") {
      e.preventDefault();
      if (!identityStore.isUnlocked) return;
      paletteOpen = !paletteOpen;
      return;
    }

    // Cmd/Ctrl+B collapses the room sidebar. The composer is a plain
    // textarea, so there is no native bold to steal.
    if (key !== "b") return;
    if (isMobile) return;
    e.preventDefault();
    setSidebarCollapsed(!displayPrefs.sidebarCollapsed);
  }}
/>

<QueryClientProvider client={queryClient}>
  <!-- No "loading && !keypair" spinner here, and it must not come back.
       identityStore.loading goes true for EVERY identity operation, not just
       the first load, and keypair stays null right through signup - the
       wizard holds its new keypair locally until the last step. So enrolling
       biometrics mid-signup swapped IdentitySetup out for a spinner and back
       in again, and a remounted IdentitySetup resets to its "entry" step:
       cancelling the authenticator prompt dropped the user back on "create a
       new identity" with the password, mnemonic and keypair they had just
       generated all gone. The genuine first-load spinner is App.svelte's,
       gated on identityStore.initializing, which is what that flag is for. -->
  {#if joiningRoom}
    <div class="min-h-screen bg-background flex items-center justify-center">
      <div class="w-2 h-2 rounded-full bg-muted-foreground animate-pulse"></div>
    </div>
  {:else if !identityStore.keypair}
    <IdentitySetup />
  {:else if !identityStore.isUnlocked}
    {#if lockedView === "restore"}
      <IdentitySetup
        initialStep="restore"
        onCancelToUnlock={() => {
          lockedView = "unlock";
        }}
      />
    {:else}
      <UnlockIdentity
        onRecover={() => {
          lockedView = "restore";
        }}
      />
    {/if}
  {:else}
    <div class="min-h-screen bg-background text-foreground font-mono flex">
      <RoomSidebar
        rooms={roomsStore.rooms}
        phonebook={dmEntries}
        {dmPreviews}
        dmUnreadCounts={dmUnreadByPeer}
        {dmUnreadTotal}
        {activeRoomCode}
        {activeDmPeerId}
        activeTab={sidebarTab}
        onChangeTab={(tab) => (sidebarTab = tab)}
        unreadCounts={roomsStore.unreadCounts}
        roomActivity={roomsStore.lastActivity}
        isOpen={sidebarOpen}
        onClose={() => (sidebarOpen = false)}
        onSelectRoom={handleSelectRoom}
        onSelectDm={handleSelectDm}
        onAddToPhonebook={handleAddToPhonebook}
        onRemoveFromPhonebook={handleRemoveFromPhonebook}
        onRemoveDmConversation={handleRemoveDm}
        onRemoveRoom={handleRemoveRoom}
        onOpenCreateJoin={openCreateJoin}
        onOpenPhonebook={() => (phonebookOpen = true)}
        collapsed={!isMobile && displayPrefs.sidebarCollapsed}
        onToggleCollapsed={() =>
          setSidebarCollapsed(!displayPrefs.sidebarCollapsed)}
      />
      <div class="flex-1 min-w-0">
        {#if activeRoomCode}
          <ChatView
            roomCode={activeRoomCode}
            roomName={transportState.roomName || activeRoomName}
            selfId={myId}
            onLeave={() =>
              isDmActive && activeDmPeerId
                ? handleRemoveDm(activeDmPeerId)
                : handleRemoveRoom()}
            onOpenSidebar={hasSidebar ? () => (sidebarOpen = true) : undefined}
            onOpenDm={handleSelectDm}
            {incomingSharedFiles}
            {incomingSharedText}
            onConsumeIncomingShared={clearIncomingShared}
          />
        {:else}
          {#if incomingSharedFiles.length > 0 || incomingSharedText}
            <Dialog.Root
              open={incomingSharedFiles.length > 0 || !!incomingSharedText}
            >
              <Dialog.Portal>
                <Dialog.Overlay
                  class="fixed inset-0 z-40 bg-black/50 "
                />
                <Dialog.Content
                  class="fixed left-1/2 top-1/2 z-50 w-[90vw] max-w-sm -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-4 shadow-lg"
                >
                  {#if incomingSharedText && incomingSharedFiles.length === 0}
                    <Dialog.Title class="font-mono text-base font-semibold">
                      Sending text
                    </Dialog.Title>
                  {:else if incomingSharedFiles.length > 0}
                    <Dialog.Title class="font-mono text-base font-semibold">
                      Sending {incomingSharedFiles.length} file{incomingSharedFiles.length ===
                      1
                        ? ""
                        : "s"}
                    </Dialog.Title>
                  {/if}

                  {#if roomsStore.rooms.length > 0}
                    <Dialog.Description
                      class="mt-1 text-sm text-muted-foreground"
                    >
                      Choose a room to send to.
                    </Dialog.Description>
                    <div class="mt-4 flex flex-col gap-2">
                      {#each roomsStore.rooms as room (room.roomCode)}
                        <button
                          type="button"
                          class="flex items-center justify-between rounded-md border border-border bg-card px-3 py-2 text-sm font-mono text-foreground hover:bg-muted cursor-pointer"
                          onclick={() => handleSelectRoom(room.roomCode)}
                        >
                          <span class="font-medium"
                            >{room.name || room.roomCode}</span
                          >
                          <span class="text-xs text-muted-foreground"
                            >{room.roomCode.slice(0, 8)}...</span
                          >
                        </button>
                      {/each}
                    </div>
                  {:else}
                    <p class="mt-4 text-sm text-muted-foreground">
                      No rooms available. Join or create a room first.
                    </p>
                  {/if}
                  <Dialog.Close
                    class="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100"
                  >
                    <X class="size-4" />
                  </Dialog.Close>
                </Dialog.Content>
              </Dialog.Portal>
            </Dialog.Root>
          {/if}
          <RoomCreateJoin
            toggleSidebar={() => {
              sidebarOpen = !sidebarOpen;
            }}
            onJoin={handleJoin}
            error={joinError}
          />
        {/if}
      </div>
      <InstallPrompt />

      <Dialog.Root bind:open={createJoinOpen}>
        <Dialog.Portal>
          <Dialog.Overlay
            class="fixed inset-0 z-40 bg-black/50 "
          />
          <Dialog.Content
            class="fixed w-sm top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 z-50 p-0 border-0 [&>div]:bg-transparent [&>div]:min-h-0 [&>div]:p-0"
          >
            <RoomCreateJoin onJoin={handleJoinFromModal} error={joinError} />
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>
    </div>
  {/if}

  {#if isMobile}
    <Drawer
      open={phonebookOpen}
      onOpenChange={(v) => (phonebookOpen = v)}
      direction="bottom"
    >
      <DrawerContent class="bg-card text-card-foreground overflow-hidden h-2/3">
        <DrawerHeader class="px-4 py-3 border-b border-border shrink-0">
          <DrawerTitle class="m-auto font-semibold flex items-center gap-2">
            <Users class="size-4 text-muted-foreground" />
            Phonebook
          </DrawerTitle>
        </DrawerHeader>
        <div class="p-3 overflow-y-auto space-y-2 min-h-50">
          {#if sortedPhonebook.length === 0}
            <div
              class="flex flex-col items-center justify-center h-40 text-muted-foreground"
            >
              <Notebook class="size-12 mb-2 opacity-50" />
              <p class="text-sm">No contacts yet</p>
            </div>
          {:else}
            <!-- Starred Contacts -->
            {@const starred = sortedPhonebook.filter((e) => e.favorite)}
            {@const regular = sortedPhonebook.filter((e) => !e.favorite)}

            {#if starred.length > 0}
              <div
                class="select-none px-2 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider font-mono"
              >
                Starred
              </div>
              {#each starred as entry (entry.peerId)}
                <div
                  class="flex items-center gap-2 rounded-md border border-border p-2 group hover:bg-accent/50 transition-colors"
                >
                  <div
                    class="size-8 rounded-full overflow-hidden bg-secondary text-secondary-foreground text-xs font-semibold font-mono flex items-center justify-center shrink-0"
                    style={colorForPeer(entry.peerId) ? `color: ${colorForPeer(entry.peerId)}` : ""}
                  >
                    {#if entry.avatarUrl}
                      <GifImage
                        src={entry.avatarUrl}
                        alt={entry.nickname}
                        class="size-full object-cover"
                        animate="hover"
                      />
                    {:else}
                      {(entry.nickname || "?").charAt(0).toUpperCase()}
                    {/if}
                  </div>
                  <button
                    class="min-w-0 flex-1 text-left"
                    onclick={() => {
                      phonebookOpen = false;
                      const contactId = entry.did || entry.peerId;
                      handleSelectDm(contactId);
                    }}
                  >
                    <div
                      class="truncate text-sm font-medium"
                      style={colorForPeer(entry.peerId) ? `color: ${colorForPeer(entry.peerId)}` : ""}
                    >
                      {entry.nickname}
                    </div>
                    <div class="truncate text-xs text-muted-foreground">
                      {entry.peerId.slice(0, 16)}
                    </div>
                  </button>
                  <Tip text="Remove from favorites">
                    {#snippet children(props)}
                  <button
                    {...props}
                    class="size-8 inline-flex items-center justify-center rounded hover:bg-accent cursor-pointer"
                    onclick={() => toggleFavorite(entry.peerId)}
                  >
                    <Star class="size-4 text-yellow-500 fill-yellow-500" />
                  </button>
                    {/snippet}
                  </Tip>
                  <Tip text="Remove contact">
                    {#snippet children(props)}
                  <button
                    {...props}
                    class="size-8 inline-flex items-center justify-center rounded hover:bg-accent cursor-pointer"
                    onclick={() => removePhonebookContact(entry.peerId)}
                    aria-label="Remove contact"
                  >
                    <Trash2 class="size-4 text-destructive" />
                  </button>
                    {/snippet}
                  </Tip>
                </div>
              {/each}
            {/if}

            <!-- Regular Contacts -->
            {#if regular.length > 0}
              {#if starred.length > 0}
                <div
                  class="select-none px-2 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider font-mono mt-4"
                >
                  Contacts
                </div>
              {/if}
              {#each regular as entry (entry.peerId)}
                <div
                  class="flex items-center gap-2 rounded-md border border-border p-2 group hover:bg-accent/50 transition-colors"
                >
                  <div
                    class="size-8 rounded-full overflow-hidden bg-secondary text-secondary-foreground text-xs font-semibold font-mono flex items-center justify-center shrink-0"
                    style={colorForPeer(entry.peerId) ? `color: ${colorForPeer(entry.peerId)}` : ""}
                  >
                    {#if entry.avatarUrl}
                      <GifImage
                        src={entry.avatarUrl}
                        alt={entry.nickname}
                        class="size-full object-cover"
                        animate="hover"
                      />
                    {:else}
                      {(entry.nickname || "?").charAt(0).toUpperCase()}
                    {/if}
                  </div>
                  <button
                    class="min-w-0 flex-1 text-left"
                    onclick={() => {
                      phonebookOpen = false;
                      const contactId = entry.did || entry.peerId;
                      handleSelectDm(contactId);
                    }}
                  >
                    <div
                      class="truncate text-sm font-medium"
                      style={colorForPeer(entry.peerId) ? `color: ${colorForPeer(entry.peerId)}` : ""}
                    >
                      {entry.nickname}
                    </div>
                    <div class="truncate text-xs text-muted-foreground">
                      {entry.peerId.slice(0, 16)}
                    </div>
                  </button>
                  <Tip text="Add to favorites">
                    {#snippet children(props)}
                  <button
                    {...props}
                    class="size-8 inline-flex items-center justify-center rounded hover:bg-accent opacity-0 group-hover:opacity-100 transition-opacity"
                    onclick={() => toggleFavorite(entry.peerId)}
                  >
                    <Star class="size-4 text-gray-400" />
                  </button>
                    {/snippet}
                  </Tip>
                  <Tip text="Remove contact">
                    {#snippet children(props)}
                  <button
                    {...props}
                    class="size-8 inline-flex items-center justify-center rounded hover:bg-accent cursor-pointer"
                    onclick={() => removePhonebookContact(entry.peerId)}
                    aria-label="Remove contact"
                  >
                    <Trash2 class="size-4 text-destructive" />
                  </button>
                    {/snippet}
                  </Tip>
                </div>
              {/each}
            {/if}
          {/if}
        </div>
      </DrawerContent>
    </Drawer>
  {:else}
    <Dialog.Root open={phonebookOpen} onOpenChange={(v) => (phonebookOpen = v)}>
      <Dialog.Portal>
        <Dialog.Overlay
          class="fixed inset-0 z-40 bg-black/50 "
        />
        <Dialog.Content
          class="fixed left-1/2 top-1/2 z-50 w-[90vw] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-lg border border-border bg-background p-4 shadow-lg min-h-75"
        >
          <Dialog.Title class="font-mono text-base font-semibold flex items-center gap-2">
            <Users class="size-4" />
            Phonebook
          </Dialog.Title>
          <div class="mt-4 max-h-96 overflow-y-auto space-y-2 min-h-50">
            {#if sortedPhonebook.length === 0}
              <div
                class="flex flex-col items-center justify-center h-40 text-muted-foreground"
              >
                <Notebook class="size-12 mb-2 opacity-50" />
                <p class="text-sm">No contacts yet</p>
              </div>
            {:else}
              <!-- Starred Contacts -->
              {@const starred = sortedPhonebook.filter((e) => e.favorite)}
              {@const regular = sortedPhonebook.filter((e) => !e.favorite)}

              {#if starred.length > 0}
                <div
                  class="select-none px-2 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider font-mono"
                >
                  Starred
                </div>
                {#each starred as entry (entry.peerId)}
                  <div
                    class="flex items-center gap-2 rounded-md border border-border p-2 group hover:bg-accent/50 transition-colors"
                  >
                    <div
                      class="size-8 rounded-full overflow-hidden bg-secondary text-secondary-foreground text-xs font-semibold font-mono flex items-center justify-center shrink-0"
                      style={colorForPeer(entry.peerId) ? `color: ${colorForPeer(entry.peerId)}` : ""}
                    >
                      {#if entry.avatarUrl}
                        <GifImage
                          src={entry.avatarUrl}
                          alt={entry.nickname}
                          class="size-full object-cover"
                          animate="hover"
                        />
                      {:else}
                        {(entry.nickname || "?").charAt(0).toUpperCase()}
                      {/if}
                    </div>
                    <button
                      class="min-w-0 flex-1 text-left"
                      onclick={() => {
                        phonebookOpen = false;
                        const contactId = entry.did || entry.peerId;
                        handleSelectDm(contactId);
                      }}
                    >
                      <div
                        class="truncate text-sm font-medium"
                        style={colorForPeer(entry.peerId) ? `color: ${colorForPeer(entry.peerId)}` : ""}
                      >
                        {entry.nickname}
                      </div>
                      <div class="truncate text-xs text-muted-foreground">
                        {entry.peerId.slice(0, 16)}
                      </div>
                    </button>
                    <Tip text="Remove from favorites">
                      {#snippet children(props)}
                    <button
                      {...props}
                      class="size-8 inline-flex items-center justify-center rounded hover:bg-accent cursor-pointer"
                      onclick={() => toggleFavorite(entry.peerId)}
                    >
                      <Star
                        class="size-4 text-yellow-500 fill-yellow-500 group-hover:hidden"
                      />
                      <Star
                        class="size-4 text-gray-400 hidden group-hover:block"
                      />
                    </button>
                      {/snippet}
                    </Tip>
                    <Tip text="Remove contact">
                      {#snippet children(props)}
                    <button
                      {...props}
                      class="size-8 inline-flex items-center justify-center rounded hover:bg-accent cursor-pointer"
                      onclick={() => removePhonebookContact(entry.peerId)}
                      aria-label="Remove contact"
                    >
                      <Trash2 class="size-4 text-destructive" />
                    </button>
                      {/snippet}
                    </Tip>
                  </div>
                {/each}
              {/if}

              <!-- Regular Contacts -->
              {#if regular.length > 0}
                {#if starred.length > 0}
                  <div
                    class="select-none px-2 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wider font-mono mt-4"
                  >
                    Contacts
                  </div>
                {/if}
                {#each regular as entry (entry.peerId)}
                  <div
                    class="flex items-center gap-2 rounded-md border border-border p-2 group hover:bg-accent/50 transition-colors"
                  >
                    <div
                      class="size-8 rounded-full overflow-hidden bg-secondary text-secondary-foreground text-xs font-semibold font-mono flex items-center justify-center shrink-0"
                      style={colorForPeer(entry.peerId) ? `color: ${colorForPeer(entry.peerId)}` : ""}
                    >
                      {#if entry.avatarUrl}
                        <GifImage
                          src={entry.avatarUrl}
                          alt={entry.nickname}
                          class="size-full object-cover"
                          animate="hover"
                        />
                      {:else}
                        {(entry.nickname || "?").charAt(0).toUpperCase()}
                      {/if}
                    </div>
                    <button
                      class="min-w-0 flex-1 text-left"
                      onclick={() => {
                        phonebookOpen = false;
                        const contactId = entry.did || entry.peerId;
                        handleSelectDm(contactId);
                      }}
                    >
                      <div
                        class="truncate text-sm font-medium"
                        style={colorForPeer(entry.peerId) ? `color: ${colorForPeer(entry.peerId)}` : ""}
                      >
                        {entry.nickname}
                      </div>
                      <div class="truncate text-xs text-muted-foreground">
                        {entry.peerId.slice(0, 16)}
                      </div>
                    </button>
                    <Tip text="Add to favorites">
                      {#snippet children(props)}
                    <button
                      {...props}
                      class="size-8 inline-flex items-center justify-center rounded hover:bg-accent cursor-pointer opacity-0 group-hover:opacity-100 transition-opacity"
                      onclick={() => toggleFavorite(entry.peerId)}
                    >
                      <Star class="size-4 text-gray-400" />
                    </button>
                      {/snippet}
                    </Tip>
                    <Tip text="Remove contact">
                      {#snippet children(props)}
                    <button
                      {...props}
                      class="size-8 inline-flex items-center justify-center rounded hover:bg-accent cursor-pointer"
                      onclick={() => removePhonebookContact(entry.peerId)}
                      aria-label="Remove contact"
                    >
                      <Trash2 class="size-4 text-destructive" />
                    </button>
                      {/snippet}
                    </Tip>
                  </div>
                {/each}
              {/if}
            {/if}
          </div>
          <Dialog.Close
            class="absolute right-4 top-4 rounded-sm opacity-70 hover:opacity-100 cursor-pointer"
          >
            <X class="size-4" />
          </Dialog.Close>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  {/if}

  <!-- OUTSIDE the unlocked branch: this component registers the service
       worker, and living inside {:else} made every lock/unlock cycle
       re-register and leak another hourly update poller - the exact
       duplicate-registration bug main.ts documents as fixed. -->
  <ReloadPrompt />

  <TransportStatus />

  <!--
    Here, not inside ChatView or the call view: both unmount when the user
    leaves the conversation or the call ends, and a floating panel that dies
    with the surface it was opened from is not floating.
  -->
  <FloatingDmPanel onExpand={expandDmPanel} />
  <CallPipPanel />

  <!--
    Browser PiP video element: lives at app level so it is available for both
    the in-app panel and the stage's PiP button (which queries it with the
    data attribute). Only rendered when in a call. Bound to the spotlight track
    regardless of whether the panel is showing.
  -->
  {#if transportState.inCall}
    <!-- Visually hidden, NOT display:none: requestPictureInPicture needs a
         video that is actually playing frames, and a display:none element is
         not rendered at all. -->
    <video
      bind:this={pipVideoElement}
      data-call-pip-video
      class="fixed bottom-0 left-0 w-px h-px opacity-0 pointer-events-none"
      autoplay
      muted
      playsinline
    ></video>
  {/if}

  <!-- Also outside the unlocked branch, for the same reason: mounting it once
       here means the palette survives lock/unlock and room switches, and it is
       reachable whether or not a room is open. It is gated on isUnlocked because
       every command needs an identity, and because openSettings' consumer only
       exists in the unlocked tree. -->
  {#if identityStore.isUnlocked}
    <CommandPalette bind:open={paletteOpen} host={paletteHost} />
    <SearchOverlay openRoom={(code) => handleSelectRoom(code)} />
    <PluginConfirmModal />
  {/if}
</QueryClientProvider>
