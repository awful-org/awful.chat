<script lang="ts">
  import { Tip } from "$lib/components/ui/tooltip";
  import {
    transportState,
    _transport,
    _voice,
  } from "$lib/transport/transport.svelte";
  import {
    Headphones,
    Signal,
    SignalHigh,
    WifiOff,
    Radio,
  } from "@lucide/svelte";
  import { onMount, onDestroy } from "svelte";
  import { cn } from "$lib/utils";
  import type { TransportStatus } from "$lib/transport/types";

  interface Props {
    /** Icon-rail layout: one icon, the whole status in a tooltip. */
    collapsed?: boolean;
  }
  let { collapsed = false }: Props = $props();

  type CallQuality = "connecting" | "p2p" | "relayed" | "degraded" | "failed";

  let quality = $state<CallQuality>("connecting");

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
        case "relay-disconnected":
          quality = "failed";
          break;
        case "relay-reconnecting":
          quality = "degraded";
          break;
        case "relay-reconnect-failed":
          quality = "failed";
          break;
        case "voice-ice-connected":
          quality = status.relayed ? "relayed" : "p2p";
          break;
        case "voice-connection-failed":
          quality = "failed";
          break;
        case "voice-peer-left":
          if ((_voice?.activePeers().length ?? 0) === 0) {
            quality = "connecting";
          }
          break;
        case "voice-degraded":
          quality = "degraded";
          break;
      }
    };

    const handleTrackAdded = () => {
      // A track is proof of connection but says nothing about the path -
      // never overwrite the ICE event's relayed verdict with "p2p".
      if (quality === "connecting" || quality === "degraded") quality = "p2p";
    };

    const handleTrackRemoved = () => {
      if ((_voice?.activePeers().length ?? 0) === 0) {
        quality = "connecting";
      }
    };

    _transport.on("status", handleStatus);
    _voice?.on("trackAdded", handleTrackAdded);
    _voice?.on("trackRemoved", handleTrackRemoved);

    handlers = [
      () => _transport?.off("status", handleStatus),
      () => _voice?.off("trackAdded", handleTrackAdded),
      () => _voice?.off("trackRemoved", handleTrackRemoved),
    ];
  });

  onDestroy(() => handlers.forEach((h) => h()));

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
</script>

{#if transportState.inCall}
  {#if collapsed}
    <Tip
      text={`${config.label} · ${transportState.roomName || "Voice"}${
        quality === "relayed" ? " · relayed" : ""
      }${deafened ? " · deafened" : ""}`}
      side="right"
    >
      {#snippet children(props)}
        <div
          {...props}
          class={cn(
            "mx-2 mb-2 flex items-center justify-center rounded-lg border py-2",
            config.bg,
            config.border
          )}
        >
          <StatusIcon class={cn("size-5", config.color)} />
        </div>
      {/snippet}
    </Tip>
  {:else}
    <div
      class={cn(
        "flex items-center justify-between px-3 py-2 rounded-lg border text-sm mb-2",
        config.bg,
        config.border
      )}
    >
      <div class="flex items-center gap-2">
        <div class={cn("relative", config.color)}>
          <StatusIcon class="size-5" />
          {#if quality === "failed"}
            <div class="absolute inset-0 flex items-center justify-center">
              <div class="w-0.5 h-3 bg-current rotate-45"></div>
            </div>
          {/if}
        </div>
        <div class="flex flex-col">
          <span class={cn("font-medium text-xs", config.color)}
            >{config.label}</span
          >
          <span class="text-[10px] text-gray-400"
            >{transportState.roomName || "Voice"}</span
          >
        </div>
      </div>

      <div class="flex items-center gap-1">
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
    </div>
  {/if}
{/if}
