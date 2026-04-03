<script lang="ts">
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

  type CallQuality = "connecting" | "p2p" | "relayed" | "degraded" | "failed";

  let quality = $state<CallQuality>("connecting");
  let deafened = $state(false);

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
          if (quality !== "failed") {
            quality = status.relayed ? "relayed" : "p2p";
          }
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
      quality = "p2p";
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

    deafened = transportState.deafened ?? false;
  });

  onDestroy(() => handlers.forEach((h) => h()));

  const config = $derived(getStatusConfig(quality));
  const StatusIcon = $derived(config.icon);
</script>

{#if transportState.inCall}
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
        <div
          class="p-1.5 rounded bg-yellow-500/10 text-yellow-400"
          title="Connected via TURN relay"
        >
          <Radio class="size-4" />
        </div>
      {/if}
      {#if deafened}
        <div class="p-1.5 rounded bg-red-500/20 text-red-400" title="Deafened">
          <Headphones class="size-4" />
        </div>
      {/if}
    </div>
  </div>
{/if}
