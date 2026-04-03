<script lang="ts">
  import { _transport } from "$lib/transport/transport.svelte";
  import type { TransportStatus } from "$lib/transport/types";
  import {
    Activity,
    Wifi,
    WifiOff,
    CircleAlert,
    Users,
    Server,
    RefreshCw,
    Unplug,
    MessageSquareOff,
    Radio,
    PhoneOff,
    Phone,
    PhoneMissed,
  } from "@lucide/svelte";
  import { onMount, onDestroy } from "svelte";
  import { cn } from "$lib/utils";

  type StatusType =
    | "connecting"
    | "connected"
    | "disconnected"
    | "error"
    | "warning";

  interface StatusItem {
    id: number;
    type: StatusType;
    message: string;
    timestamp: number;
    icon?: typeof Activity;
  }

  let statusItems = $state<StatusItem[]>([]);
  let itemId = 0;
  let relayConnected = $state(true);
  let peerCount = $state(0);
  let isMobile = $state(false);
  let isVisible = $state(true);

  let handlers: (() => void)[] = [];

  // Initialize visibility based on device type
  $effect(() => {
    const media = window.matchMedia("(max-width: 768px)");
    isMobile = media.matches;
    isVisible = !isMobile; // Default open on desktop, closed on mobile

    const listener = (e: MediaQueryListEvent) => {
      isMobile = e.matches;
    };
    media.addEventListener("change", listener);
    return () => media.removeEventListener("change", listener);
  });

  function addStatus(
    type: StatusType,
    message: string,
    icon?: typeof Activity
  ) {
    const item: StatusItem = {
      id: ++itemId,
      type,
      message,
      timestamp: Date.now(),
      icon,
    };
    statusItems = [item, ...statusItems].slice(0, 5);

    // Auto-remove after appropriate duration
    const duration =
      type === "error" ? 10000 : type === "warning" ? 8000 : 5000;
    setTimeout(() => {
      statusItems = statusItems.filter((i) => i.id !== item.id);
    }, duration);
  }

  function updatePeerCount() {
    peerCount = _transport ? _transport.peers().length : 0;
  }

  onMount(() => {
    if (!_transport) return;

    // Listen for transport status events
    const handleStatus = (status: TransportStatus) => {
      switch (status.type) {
        case "relay-connected":
          relayConnected = true;
          addStatus("connected", status.message, Server);
          break;
        case "relay-disconnected":
          relayConnected = false;
          addStatus("error", status.message, Unplug);
          break;
        case "relay-dial-failed":
          addStatus("error", status.message, CircleAlert);
          break;
        case "relay-reconnecting":
          addStatus("warning", status.message, RefreshCw);
          break;
        case "relay-reconnect-failed":
          addStatus("error", status.message, CircleAlert);
          break;
        case "stream-open-failed":
          addStatus("error", status.message, MessageSquareOff);
          break;
        case "rendezvous-failed":
          addStatus("error", status.message, Radio);
          break;
        case "rendezvous-reconnecting":
          addStatus("warning", status.message, RefreshCw);
          break;
        case "reservation-timeout":
          addStatus("error", status.message, CircleAlert);
          break;
        case "peer-dial-failed":
          addStatus("error", status.message, CircleAlert);
          break;
        case "voice-ice-connected":
          addStatus(
            "connected",
            status.message,
            status.relayed ? Radio : Phone
          );
          break;
        case "voice-connection-failed":
          addStatus("error", status.message, PhoneMissed);
          break;
        case "voice-dial-failed":
          addStatus("error", status.message, PhoneOff);
          break;
        case "voice-dial-retrying":
          addStatus("warning", status.message, RefreshCw);
          break;
        case "voice-peer-left":
          addStatus("disconnected", status.message, PhoneOff);
          break;
      }
    };

    // Listen for peer connect/disconnect
    const handleConnect = (peerId: string) => {
      updatePeerCount();
      const shortId = peerId.slice(-8);
      addStatus("connected", `Connected to ${shortId}`, Wifi);
    };

    const handleDisconnect = (peerId: string) => {
      updatePeerCount();
      const shortId = peerId.slice(-8);
      addStatus("disconnected", `Disconnected from ${shortId}`, WifiOff);
    };

    // Attach transport listeners
    _transport.on("connect", handleConnect);
    _transport.on("disconnect", handleDisconnect);
    _transport.on("status", handleStatus);

    handlers = [
      () => _transport?.off("connect", handleConnect),
      () => _transport?.off("disconnect", handleDisconnect),
      () => _transport?.off("status", handleStatus),
    ];

    updatePeerCount();
  });

  onDestroy(() => {
    handlers.forEach((h) => h());
  });

  function getStatusColor(type: StatusType): string {
    switch (type) {
      case "connected":
        return "text-green-500";
      case "connecting":
        return "text-yellow-500";
      case "disconnected":
        return "text-orange-500";
      case "error":
        return "text-red-500";
      case "warning":
        return "text-yellow-500";
      default:
        return "text-muted-foreground";
    }
  }

  function getStatusBg(type: StatusType): string {
    switch (type) {
      case "connected":
        return "bg-green-500/10 border-green-500/20";
      case "connecting":
        return "bg-yellow-500/10 border-yellow-500/20";
      case "disconnected":
        return "bg-orange-500/10 border-orange-500/20";
      case "error":
        return "bg-red-500/10 border-red-500/20";
      case "warning":
        return "bg-yellow-500/10 border-yellow-500/20";
      default:
        return "bg-muted border-border";
    }
  }
</script>

{#if statusItems.length > 0 || !relayConnected || peerCount > 0}
  <div
    class={cn(
      "fixed z-50 flex flex-col gap-2 max-w-sm",
      "bottom-20 right-3.75",
      isVisible ? "opacity-100" : "opacity-0 pointer-events-none"
    )}
  >
    <!-- Connection Summary -->
    {#if peerCount > 0 || !relayConnected}
      <div
        class="flex items-center gap-2 px-3 py-2 rounded-lg border bg-background/95 backdrop-blur shadow-lg text-xs"
      >
        {#if !relayConnected}
          <div class="flex items-center gap-1.5 text-red-500">
            <WifiOff class="size-3.5" />
            <span>Relay disconnected</span>
          </div>
        {:else}
          <div class="flex items-center gap-1.5 text-green-500">
            <Wifi class="size-3.5" />
            <span>Relay connected</span>
          </div>
        {/if}

        {#if peerCount > 0}
          <div class="flex items-center gap-1.5 text-blue-500 ml-auto">
            <Users class="size-3.5" />
            <span>{peerCount} peer{peerCount === 1 ? "" : "s"}</span>
          </div>
        {/if}

        <button
          class="ml-2 text-muted-foreground hover:text-foreground transition-colors"
          onclick={() => (isVisible = false)}
          aria-label="Hide status"
        >
          ×
        </button>
      </div>
    {/if}

    <!-- Status Items -->
    {#each statusItems as item (item.id)}
      <div
        class={cn(
          "flex items-center gap-2 px-3 py-2 rounded-lg border text-xs animate-in fade-in slide-in-from-right-2 duration-200",
          getStatusBg(item.type)
        )}
        role="status"
      >
        {#if item.icon}
          <item.icon class={cn("size-3.5", getStatusColor(item.type))} />
        {:else}
          <CircleAlert class={cn("size-3.5", getStatusColor(item.type))} />
        {/if}
        <span class="flex-1">{item.message}</span>
      </div>
    {/each}
  </div>
{/if}

<!-- Toggle button when hidden -->
{#if !isVisible && (peerCount > 0 || !relayConnected)}
  <button
    class="fixed bottom-20 right-3.75 z-50 p-2 rounded-full bg-background border shadow-lg hover:bg-accent transition-colors"
    onclick={() => (isVisible = true)}
    aria-label="Show transport status"
  >
    <Activity class="size-4" />
  </button>
{/if}
