<script lang="ts">
  import {
    transportState,
    _transport,
    _voice,
  } from "$lib/transport/transport.svelte";
  import { Headphones, Signal, SignalHigh, WifiOff } from "@lucide/svelte";
  import { onMount, onDestroy } from "svelte";
  import { cn } from "$lib/utils";
  import type { TransportStatus } from "$lib/transport/types";

  let peerCount = $state(0);
  let relayConnected = $state(true);
  let voiceConnected = $state(false);
  let muted = $state(false);
  let deafened = $state(false);

  type AggregatedStatus =
    | "connected"
    | "connecting"
    | "disconnected"
    | "reconnecting"
    | "error";
  let currentStatus = $state<AggregatedStatus>("connecting");
  let errorMessage = $state<string | null>(null);

  let handlers: (() => void)[] = [];

  onMount(() => {
    if (!_transport) return;

    const handleStatus = (status: TransportStatus) => {
      switch (status.type) {
        case "relay-connected":
          relayConnected = true;
          updateAggregatedStatus();
          break;
        case "relay-disconnected":
          relayConnected = false;
          currentStatus = "disconnected";
          break;
        case "relay-dial-failed":
          currentStatus = "error";
          errorMessage = "Failed to connect";
          break;
        case "relay-reconnecting":
          currentStatus = "reconnecting";
          break;
        case "relay-reconnect-failed":
          currentStatus = "error";
          errorMessage = "Connection failed";
          break;
        case "peer-connected":
        case "peer-disconnected":
          peerCount = _transport?.peers().length ?? 0;
          break;
        case "rendezvous-failed":
        case "rendezvous-reconnecting":
          currentStatus = "reconnecting";
          break;
      }
    };

    const handleTrackAdded = () => {
      voiceConnected = true;
      updateAggregatedStatus();
    };

    const handleTrackRemoved = () => {
      if (_voice?.activePeers().length === 0) {
        voiceConnected = false;
        updateAggregatedStatus();
      }
    };

    const handleError = (err: Error) => {
      currentStatus = "error";
      errorMessage = err.message;
    };

    _transport.on("status", handleStatus);
    _voice?.on("trackAdded", handleTrackAdded);
    _voice?.on("trackRemoved", handleTrackRemoved);
    _voice?.on("error", handleError);

    handlers = [
      () => _transport?.off("status", handleStatus),
      () => _voice?.off("trackAdded", handleTrackAdded),
      () => _voice?.off("trackRemoved", handleTrackRemoved),
      () => _voice?.off("error", handleError),
    ];

    peerCount = _transport.peers().length;
    muted = transportState.muted ?? false;
    deafened = transportState.deafened ?? false;
  });

  function updateAggregatedStatus() {
    if (!relayConnected) {
      currentStatus = "disconnected";
      errorMessage = null;
    } else if (!voiceConnected) {
      currentStatus = "connecting";
      errorMessage = null;
    } else {
      currentStatus = "connected";
      errorMessage = null;
    }
  }

  onDestroy(() => {
    handlers.forEach((h) => h());
  });

  function getStatusConfig(status: AggregatedStatus): {
    color: string;
    bgColor: string;
    icon: typeof SignalHigh;
    label: string;
  } {
    switch (status) {
      case "connected":
        return {
          color: "text-green-400",
          bgColor: "bg-green-500/10",
          icon: SignalHigh,
          label: "Connected",
        };
      case "connecting":
        return {
          color: "text-yellow-400",
          bgColor: "bg-yellow-500/10",
          icon: Signal,
          label: "Connecting...",
        };
      case "reconnecting":
        return {
          color: "text-orange-400",
          bgColor: "bg-orange-500/10",
          icon: Signal,
          label: "Reconnecting...",
        };
      case "disconnected":
        return {
          color: "text-red-400",
          bgColor: "bg-red-500/10",
          icon: WifiOff,
          label: "Disconnected",
        };
      case "error":
        return {
          color: "text-red-400",
          bgColor: "bg-red-500/10",
          icon: WifiOff,
          label: errorMessage || "Error",
        };
    }
  }

  const config = $derived(getStatusConfig(currentStatus));
  const StatusIcon = $derived(config.icon);
</script>

{#if transportState.inCall}
  <div
    class={cn(
      "flex items-center justify-between px-3 py-2 rounded-lg border text-sm mb-2",
      config.bgColor,
      config.color === "text-green-400"
        ? "border-green-500/20"
        : config.color === "text-yellow-400"
          ? "border-yellow-500/20"
          : config.color === "text-orange-400"
            ? "border-orange-500/20"
            : "border-red-500/20"
    )}
  >
    <!-- Left: Status indicator -->
    <div class="flex items-center gap-2">
      <div class={cn("relative", config.color)}>
        <StatusIcon class="size-5" />
        {#if currentStatus === "disconnected" || currentStatus === "error"}
          <div class="absolute inset-0 flex items-center justify-center">
            <div class="w-0.5 h-3 bg-current rotate-45"></div>
          </div>
        {/if}
      </div>
      <div class="flex flex-col">
        <span class={cn("font-medium text-xs", config.color)}>
          {config.label}
        </span>
        <span class="text-[10px] text-gray-400">
          {transportState.roomName || "Voice"}
        </span>
      </div>
    </div>

    <!-- Right: Controls -->
    <div class="flex items-center gap-1">
      {#if deafened}
        <div
          class={cn("p-1.5 rounded", "bg-red-500/20", "text-red-400")}
          title="Deafened"
        >
          <Headphones class="size-4" />
        </div>
      {/if}
    </div>
  </div>
{/if}
