<script lang="ts">
  import type { Message, ParticipantState } from "$lib/transport.svelte";
  import {
    LogOut,
    Menu,
    Phone,
    Send,
    Users,
    Copy,
    Check,
    ImagePlay,
    ChevronUp,
  } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";
  import { Badge } from "$lib/components/ui/badge";
  import { Separator } from "$lib/components/ui/separator";
  import VoiceVideoCallView from "./VoiceVideoCallView.svelte";
  import GifPicker from "./GifPicker.svelte";
  import { profileStore, loadProfile } from "$lib/profile.svelte";
  import { loadMoreMessages, markSeen } from "$lib/transport.svelte";

  $effect(() => {
    loadProfile();
  });

  interface Props {
    roomCode: string;
    roomName: string;
    peers: string[];
    messages: Message[];
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
    error?: string | null;
    onLeave: () => void;
    onOpenSidebar?: () => void;
    onSendMessage: (text: string) => void;
    onJoinCall: () => void;
    onLeaveCall: () => void;
    onToggleMute: () => void;
    onToggleCamera: () => void;
    onStartScreenShare: () => void;
    onStopScreenShare: () => void;
  }

  let {
    roomCode,
    roomName,
    peers,
    messages,
    participants,
    localCameraStream,
    localScreenStream,
    localMicStream,
    inCall,
    muted,
    cameraOff,
    screenSharing,
    selfId,
    callPeerIds = new Set(),
    peerNames = new Map(),
    peerAvatars = new Map(),
    error = null,
    onLeave,
    onOpenSidebar,
    onSendMessage,
    onJoinCall,
    onLeaveCall,
    onToggleMute,
    onToggleCamera,
    onStartScreenShare,
    onStopScreenShare,
  }: Props = $props();

  let draft = $state("");
  let gifPickerOpen = $state(false);
  let hasMoreHistory = $state(true);
  let loadingMore = $state(false);

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  }

  function submit() {
    const text = draft.trim();
    if (!text) return;
    onSendMessage(text);
    draft = "";
    autoScroll = true;
    requestAnimationFrame(() => textareaEl?.focus());
  }

  function handleGifSelect(url: string) {
    onSendMessage(url);
    autoScroll = true;
  }

  async function handleLoadMore() {
    if (loadingMore || !hasMoreHistory || messages.length === 0) return;
    loadingMore = true;
    const oldest = messages[0].lamport;
    const more = await loadMoreMessages(oldest);
    hasMoreHistory = more;
    loadingMore = false;
  }

  let textareaEl = $state<HTMLTextAreaElement | null>(null);

  let copied = $state(false);
  async function copyCode() {
    await navigator.clipboard.writeText(window.location.href);
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  let messagesEl = $state<HTMLDivElement | null>(null);
  let autoScroll = $state(true);

  function handleScroll() {
    if (!messagesEl) return;
    const { scrollHeight, scrollTop, clientHeight } = messagesEl;
    autoScroll = scrollHeight - scrollTop - clientHeight < 40;
  }

  $effect(() => {
    messages.length;
    if (autoScroll && messagesEl) {
      setTimeout(() => {
        if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
      }, 0);
    }
  });

  $effect(() => {
    if (messages.length > 0) markSeen().catch(() => {});
  });

  function shouldShowHeader(current: Message, previous?: Message): boolean {
    if (!previous) return true;
    if (current.senderId !== previous.senderId) return true;
    return current.timestamp - previous.timestamp > 2 * 60 * 1000;
  }

  function shouldShowDateSep(current: number, previous?: number): boolean {
    if (!previous) return true;
    return (
      new Date(current).toDateString() !== new Date(previous).toDateString()
    );
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
    });
  }

  function formatDate(ts: number): string {
    const date = new Date(ts);
    const today = new Date();
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    if (date.toDateString() === today.toDateString()) return "Today";
    if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
    return date.toLocaleDateString([], {
      month: "short",
      day: "numeric",
      year: date.getFullYear() !== today.getFullYear() ? "numeric" : undefined,
    });
  }

  function initials(msg: Message): string {
    return (msg.senderName || msg.senderId).charAt(0).toUpperCase();
  }

  function displayName(msg: Message): string {
    return (
      peerNames.get(msg.senderId) || msg.senderName || msg.senderId.slice(0, 8)
    );
  }

  function isGifUrl(text: string): boolean {
    return (
      /^https?:\/\/.+\.(gif|webp)(\?.*)?$/i.test(text) ||
      /klipy\.co|tenor\.com|giphy\.com/i.test(text)
    );
  }
</script>

<div class="flex h-dvh flex-col bg-background text-foreground font-mono">
  <header class="border-b border-border px-4 py-3 shrink-0">
    <div class="flex items-center justify-between gap-2">
      <div class="flex items-center gap-2 min-w-0">
        {#if onOpenSidebar}
          <Button
            variant="ghost"
            size="icon"
            onclick={onOpenSidebar}
            aria-label="Open rooms sidebar"
            class="sm:hidden shrink-0 cursor-pointer -ml-1 text-muted-foreground hover:text-foreground"
          >
            <Menu class="size-4" />
          </Button>
        {/if}
        <h1 class="text-sm font-semibold truncate text-foreground">
          {roomName || roomCode}
        </h1>
        <Badge
          variant="outline"
          class="gap-1 text-xs shrink-0 border-border text-muted-foreground"
        >
          <Users class="size-3" />
          {peers.length + 1}
        </Badge>
      </div>
      <div class="flex items-center gap-2 shrink-0">
        <button
          type="button"
          onclick={copyCode}
          aria-label="Copy room code"
          class="hidden sm:flex items-center gap-1 rounded bg-muted px-1.5 py-0.5 text-xs font-mono text-muted-foreground hover:text-foreground transition-colors"
        >
          <code>{roomCode}</code>
          {#if copied}
            <Check class="size-3 text-emerald-500 " />
          {:else}
            <Copy class="size-3 mb-0.5" />
          {/if}
        </button>
        {#if !inCall}
          <Button
            variant="ghost"
            size="icon"
            onclick={onJoinCall}
            aria-label="Join call"
            class="text-muted-foreground hover:text-foreground cursor-pointer"
          >
            <Phone class="size-4" />
          </Button>
        {/if}
        <Button
          variant="ghost"
          size="icon"
          onclick={onLeave}
          aria-label="Leave room"
          class="text-destructive hover:text-destructive/80 cursor-pointer"
        >
          <LogOut class="size-4" />
        </Button>
      </div>
    </div>
  </header>

  <VoiceVideoCallView
    {participants}
    {localCameraStream}
    {localScreenStream}
    {localMicStream}
    {inCall}
    {muted}
    {cameraOff}
    {screenSharing}
    {selfId}
    {callPeerIds}
    {peerNames}
    {error}
    {onJoinCall}
    {onLeaveCall}
    {onToggleMute}
    {onToggleCamera}
    {onStartScreenShare}
    {onStopScreenShare}
  />

  <div
    bind:this={messagesEl}
    onscroll={handleScroll}
    class="flex-1 overflow-y-auto overflow-x-hidden px-4 py-2 min-h-0"
  >
    {#if hasMoreHistory && messages.length >= 50}
      <div class="flex justify-center py-2">
        <Button
          variant="ghost"
          size="sm"
          onclick={handleLoadMore}
          disabled={loadingMore}
          class="gap-1.5 text-xs text-muted-foreground font-mono cursor-pointer"
        >
          <ChevronUp class="size-3.5" />
          {loadingMore ? "Loading..." : "Load older messages"}
        </Button>
      </div>
    {/if}

    {#if messages.length === 0}
      <div class="flex h-full items-center justify-center py-20">
        <p class="text-sm text-muted-foreground italic">
          No messages yet. Say something!
        </p>
      </div>
    {:else}
      <div class="space-y-0.5">
        {#each messages as msg, i (msg.id)}
          {@const prev = messages[i - 1]}
          {@const showDate = shouldShowDateSep(msg.timestamp, prev?.timestamp)}
          {@const showHeader = shouldShowHeader(msg, prev)}
          {@const isOwn = msg.senderId === selfId}
          {@const isGif = isGifUrl(msg.content)}
          <div>
            {#if showDate}
              <div class="flex items-center gap-3 py-3">
                <Separator class="flex-1 bg-border" />
                <span class="text-xs text-muted-foreground"
                  >{formatDate(msg.timestamp)}</span
                >
                <Separator class="flex-1 bg-border" />
              </div>
            {/if}
            <div
              class="group rounded-md px-2 py-0.5 hover:bg-muted/50 {showHeader
                ? 'mt-3 pt-1'
                : ''}"
            >
              {#if showHeader}
                <div class="flex items-start gap-2">
                  <div
                    class="mt-0.5 flex size-7 shrink-0 items-center justify-center rounded-full overflow-hidden text-xs font-semibold
                      {isOwn
                      ? 'bg-primary/20 text-primary'
                      : 'bg-secondary text-secondary-foreground'}"
                  >
                    {#if isOwn && profileStore.avatarUrl}
                      <img
                        src={profileStore.avatarUrl}
                        alt="You"
                        class="size-full object-cover"
                      />
                    {:else if !isOwn && peerAvatars.get(msg.senderId)}
                      <img
                        src={peerAvatars.get(msg.senderId)}
                        alt={displayName(msg)}
                        class="size-full object-cover"
                      />
                    {:else}
                      {initials(msg)}
                    {/if}
                  </div>
                  <div class="flex items-baseline gap-2">
                    <span
                      class="text-sm font-medium {isOwn
                        ? 'text-primary'
                        : 'text-foreground'}"
                    >
                      {isOwn
                        ? profileStore.nickname || "You"
                        : displayName(msg)}
                    </span>
                    <span class="text-xs text-muted-foreground"
                      >{formatTime(msg.timestamp)}</span
                    >
                  </div>
                </div>
              {/if}
              <div class="ml-9 text-sm text-foreground wrap-break-word">
                {#if isGif}
                  <img
                    src={msg.content}
                    alt="GIF"
                    class="max-w-xs max-h-48 rounded-md mt-1 object-contain"
                    loading="lazy"
                  />
                {:else}
                  <p class="whitespace-pre-wrap">{msg.content}</p>
                {/if}
              </div>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>

  {#if !autoScroll && messages.length > 0}
    <div class="flex justify-center -mt-10 relative z-10">
      <Button
        variant="secondary"
        size="sm"
        class="rounded-full shadow-md font-mono text-xs"
        onclick={() => {
          if (messagesEl) messagesEl.scrollTop = messagesEl.scrollHeight;
          autoScroll = true;
        }}
      >
        New messages below
      </Button>
    </div>
  {/if}

  <div
    class="border-t border-border p-4 pb-[max(1rem,env(safe-area-inset-bottom))] shrink-0"
  >
    <form
      onsubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      class="flex gap-2"
    >
      <Button
        type="button"
        variant="ghost"
        size="icon"
        onclick={() => (gifPickerOpen = true)}
        aria-label="Send a GIF"
        class="size-10 shrink-0 text-muted-foreground hover:text-foreground cursor-pointer"
      >
        <ImagePlay class="size-4" />
      </Button>
      <textarea
        bind:this={textareaEl}
        bind:value={draft}
        onkeydown={handleKeydown}
        placeholder="Type a message…"
        rows={1}
        class="flex-1 resize-none rounded-md border border-input bg-background px-3 py-2 text-sm text-foreground placeholder:text-muted-foreground font-mono focus:outline-none focus:ring-1 focus:ring-ring min-h-10 max-h-30"
      ></textarea>
      <Button
        type="submit"
        size="icon"
        disabled={!draft.trim()}
        aria-label="Send message"
        class="size-11 sm:size-10 shrink-0 bg-primary hover:bg-primary/90 text-primary-foreground disabled:opacity-30"
      >
        <Send class="size-4" />
      </Button>
    </form>
  </div>
</div>

<GifPicker
  open={gifPickerOpen}
  onOpenChange={(v) => (gifPickerOpen = v)}
  onSelect={handleGifSelect}
/>
