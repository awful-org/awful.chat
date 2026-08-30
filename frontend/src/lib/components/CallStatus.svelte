<script lang="ts">
  import { Tip } from "$lib/components/ui/tooltip";
  import {
    transportState,
    _transport,
    _voice,
  } from "$lib/transport/transport.svelte";
  import {
    CornerUpLeft,
    Headphones,
    Signal,
    SignalHigh,
    WifiOff,
    Radio,
  } from "@lucide/svelte";
  import { roomsStore } from "$lib/rooms.svelte";
  import { requestReturnToCall } from "$lib/ui-state.svelte";
  import { onMount, onDestroy } from "svelte";
  import { cn } from "$lib/utils";
  import type { TransportStatus } from "$lib/transport/types";
  import {
    applyCallQualityStatus,
    noteTrackAdded,
    worstQuality,
    type PeerVoiceQuality,
  } from "$lib/call-quality";

  interface Props {
    /** Icon-rail layout: one icon, the whole status in a tooltip. */
    collapsed?: boolean;
  }
  let { collapsed = false }: Props = $props();

  type CallQuality = "connecting" | "p2p" | "relayed" | "degraded" | "failed";

  // Per-peer voice link quality, keyed by peerId. A single shared value let
  // one peer's "degraded" paint the whole call, and let any OTHER peer's
  // trackAdded erase it moments later (voice-audit finding 8) - keying by
  // peerId makes that impossible. transportQuality is a separate axis: the
  // relay itself can fail while every peer's own verdict is still the
  // healthy one from before the drop.
  let peerQuality = $state<Map<string, PeerVoiceQuality>>(new Map());
  let transportQuality = $state<"ok" | "degraded" | "failed">("ok");

  const QUALITY_RANK: Record<CallQuality, number> = {
    connecting: 0,
    p2p: 1,
    relayed: 1,
    degraded: 2,
    failed: 3,
  };

  let handlers: (() => void)[] = [];

  function getStatusConfig(q: CallQuality) {
    switch (q) {
      case "p2p":
        return {
          color: "text-green-400",
          bg: "bg-green-500/10",
          border: "border-green-500/20",
          icon: SignalHigh,
          label: "Connected",
        };
      case "relayed":
        return {
          color: "text-green-400",
          bg: "bg-green-500/10",
          border: "border-green-500/20",
          icon: SignalHigh,
          label: "Connected (relay)",
        };
      case "degraded":
        return {
          color: "text-orange-400",
          bg: "bg-orange-500/10",
          border: "border-orange-500/20",
          icon: Signal,
          label: "Poor connection",
        };
      case "failed":
        return {
          color: "text-red-400",
          bg: "bg-red-500/10",
          border: "border-red-500/20",
          icon: WifiOff,
          label: "Failed",
        };
      case "connecting":
      default:
        return {
          color: "text-yellow-400",
          bg: "bg-yellow-500/10",
          border: "border-yellow-500/20",
          icon: Signal,
          label: "Connecting...",
        };
    }
  }

  onMount(() => {
    if (!_transport) return;

    const handleStatus = (status: TransportStatus) => {
      switch (status.type) {
        case "relay-connected":
          transportQuality = "ok";
          break;
        case "relay-disconnected":
          transportQuality = "failed";
          break;
        case "relay-reconnecting":
          transportQuality = "degraded";
          break;
        case "relay-reconnect-failed":
          transportQuality = "failed";
          break;
        case "voice-ice-connected":
        case "voice-connection-failed":
        case "voice-degraded":
        case "voice-peer-left":
          peerQuality = new Map(applyCallQualityStatus(peerQuality, status));
          break;
      }
    };

    const handleTrackAdded = (peerId: string) => {
      // A track is proof of connection but says nothing about the path -
      // never overwrite an existing verdict, ours or another peer's, with
      // the mere fact that a track arrived.
      peerQuality = new Map(noteTrackAdded(peerQuality, peerId));
    };

    _transport.on("status", handleStatus);
    _voice?.on("trackAdded", handleTrackAdded);

    handlers = [
      () => _transport?.off("status", handleStatus),
      () => _voice?.off("trackAdded", handleTrackAdded),
    ];
  });

  onDestroy(() => handlers.forEach((h) => h()));

  // The one summary badge: the worse of "is the relay itself in trouble"
  // and "is any peer's own voice link in trouble" - never a value some
  // unrelated peer's event can stomp.
  const quality = $derived.by<CallQuality>(() => {
    const worst = worstQuality(peerQuality);
    const peerLevel: CallQuality = worst ?? "connecting";
    const transportLevel: CallQuality =
      transportQuality === "ok" ? "connecting" : transportQuality;
    return QUALITY_RANK[transportLevel] >= QUALITY_RANK[peerLevel]
      ? transportLevel
      : peerLevel;
  });

  // "Connected" used to flip on the FIRST peer while the rest were still
  // handshaking - true for one friend, false for the call. Compare who is
  // actually connected against who announced they are in this call.
  let activeCount = $state(0);
  let expectedCount = $state(0);

  $effect(() => {
    const tick = setInterval(() => {
      if (!transportState.inCall) return;
      activeCount = _voice?.activePeers().length ?? 0;
      let expected = 0;
      const self = _transport?.selfId();
      for (const [pid, room] of transportState.callPeerRooms) {
        if (room === transportState.callRoomCode && pid !== self) expected++;
      }
      expectedCount = expected;
    }, 1000);
    return () => clearInterval(tick);
  });

  const deafened = $derived(transportState.deafened ?? false);
  const config = $derived.by(() => {
    const base = getStatusConfig(quality);
    if (quality === "failed" || quality === "degraded") return base;
    if (expectedCount === 0) {
      // Alone in the call is a HEALTHY state, not a pending one: everything
      // is connected and ready, there is just nobody else yet - green.
      return { ...getStatusConfig("p2p"), label: "Waiting for others" };
    }
    if (activeCount === 0) return getStatusConfig("connecting");
    if (activeCount < expectedCount) {
      return {
        ...getStatusConfig("connecting"),
        label: `Connecting ${activeCount}/${expectedCount}...`,
      };
    }
    // Everyone announced is connected; if the ICE event was missed, the
    // active peers are still proof enough.
    return quality === "connecting" ? getStatusConfig("p2p") : base;
  });
  const StatusIcon = $derived(config.icon);

  // The room the CALL is in, not the one on screen. Reading transportState
  // .roomName meant that as soon as you looked elsewhere the chip announced
  // "Connected" under the name of a room you were not calling in.
  const callRoomName = $derived.by(() => {
    const code = transportState.callRoomCode;
    if (!code) return "Voice";
    if (code.startsWith("dm-")) {
      const did = roomsStore.dmRooms.find(
        (r) => r.roomCode === code
      )?.participantDid;
      return (did && transportState.peerNames.get(did)) || "Direct call";
    }
    return roomsStore.rooms.find((r) => r.roomCode === code)?.name || code;
  });

  // Away from the call the chip stops being a status line and becomes the way
  // back: nothing else on screen leads there, and the call keeps running
  // regardless of what the user is looking at.
  const away = $derived(
    transportState.inCall &&
      !!transportState.callRoomCode &&
      transportState.uiRoomCode !== transportState.callRoomCode
  );
</script>

{#if transportState.inCall}
  {#if collapsed}
    <Tip
      text={`${away ? "Back to call · " : ""}${config.label} · ${callRoomName}${
        quality === "relayed" ? " · relayed" : ""
      }${deafened ? " · deafened" : ""}`}
      side="right"
    >
      {#snippet children(props)}
        <svelte:element
          this={away ? "button" : "div"}
          {...props}
          type={away ? "button" : undefined}
          role={away ? "button" : undefined}
          aria-label={away ? `Back to call in ${callRoomName}` : undefined}
          onclick={away ? requestReturnToCall : undefined}
          class={cn(
            "mx-2 mb-2 flex items-center justify-center rounded-lg border py-2",
            config.bg,
            config.border,
            away && "cursor-pointer hover:brightness-125"
          )}
        >
          {#if away}
            <CornerUpLeft class={cn("size-5", config.color)} />
          {:else}
            <StatusIcon class={cn("size-5", config.color)} />
          {/if}
        </svelte:element>
      {/snippet}
    </Tip>
  {:else}
    <svelte:element
      this={away ? "button" : "div"}
      type={away ? "button" : undefined}
      role={away ? "button" : undefined}
      aria-label={away ? `Back to call in ${callRoomName}` : undefined}
      onclick={away ? requestReturnToCall : undefined}
      class={cn(
        "flex items-center justify-between px-3 py-2 rounded-lg border text-sm mb-2",
        config.bg,
        config.border,
        away && "w-full text-left cursor-pointer hover:brightness-125"
      )}
    >
      <div class="flex items-center gap-2 min-w-0">
        <div class={cn("relative shrink-0", config.color)}>
          {#if away}
            <CornerUpLeft class="size-5" />
          {:else}
            <StatusIcon class="size-5" />
            {#if quality === "failed"}
              <div class="absolute inset-0 flex items-center justify-center">
                <div class="w-0.5 h-3 bg-current rotate-45"></div>
              </div>
            {/if}
          {/if}
        </div>
        <div class="flex flex-col min-w-0">
          <span class={cn("font-medium text-xs", config.color)}
            >{away ? "Back to call" : config.label}</span
          >
          <span class="text-[10px] text-gray-400 truncate">{callRoomName}</span>
        </div>
      </div>

      <div class="flex items-center gap-1 shrink-0">
        {#if quality === "relayed"}
          <Tip text="Connected via TURN relay">
            {#snippet children(props)}
              <div
                {...props}
                class="p-1.5 rounded bg-yellow-500/10 text-yellow-400"
              >
                <Radio class="size-4" />
              </div>
            {/snippet}
          </Tip>
        {/if}
        {#if deafened}
          <Tip text="Deafened">
            {#snippet children(props)}
              <div {...props} class="p-1.5 rounded bg-red-500/20 text-red-400">
                <Headphones class="size-4" />
              </div>
            {/snippet}
          </Tip>
        {/if}
      </div>
    </svelte:element>
  {/if}
{/if}
