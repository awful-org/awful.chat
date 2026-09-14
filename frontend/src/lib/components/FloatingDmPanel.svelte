<script lang="ts">
  import { CornerUpLeft, Minus, Send, X } from "@lucide/svelte";
  import { Tip } from "$lib/components/ui/tooltip";
  import { draggable } from "$lib/actions/draggable";
  import {
    BAR_HEIGHT,
    HEIGHT,
    panelWidth,
    dmPanel,
    defaultPanelPosition,
  } from "$lib/dm-panel.svelte";
  import { closeDmPanel, sendDirectMessage } from "$lib/transport/dm.svelte";
  import { displayPrefs } from "$lib/display-prefs.svelte";
  import { resolveChatFontStack } from "$lib/chat-font";
  import {
    requestFileDownload,
    selfId,
    transportState,
  } from "$lib/transport/transport.svelte";
  import MsgRender from "./MsgRender.svelte";
  import { MessageType, type Message } from "$lib/types/message";

  interface Props {
    /** Focus this conversation in the DMs tab and close the panel. */
    onExpand: (peerId: string) => void;
  }
  let { onExpand }: Props = $props();

  let draft = $state("");
  let sendError = $state<string | null>(null);
  let sending = $state(false);
  let list = $state<HTMLDivElement | null>(null);

  // Reactions are folded onto their target elsewhere; on their own they are
  // rows with nothing to read.
  const visible = $derived(
    dmPanel.messages.filter((m) => m.type !== MessageType.Reaction)
  );

  /**
   * Same rule the chat pane uses: a header when the speaker changes, or after a
   * two minute gap. A DM has two participants, so the name and the time are the
   * whole header - the pane's avatars, colours and tags do not fit 340px.
   */
  function startsGroup(current: Message, previous?: Message): boolean {
    if (!previous) return true;
    if (current.senderId !== previous.senderId) return true;
    return current.timestamp - previous.timestamp > 2 * 60 * 1000;
  }

  function formatTime(ts: number): string {
    return new Date(ts).toLocaleTimeString([], {
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    });
  }

  let width = $state(panelWidth());
  let viewportHeight = $state(typeof window === "undefined" ? HEIGHT + 16 : window.innerHeight);
  const height = $derived(Math.min(dmPanel.minimized ? BAR_HEIGHT : HEIGHT, Math.max(BAR_HEIGHT, viewportHeight - 16)));
  const chatFontStack = $derived(
    resolveChatFontStack(displayPrefs.chatFontFamily),
  );

  // A viewport that shrank under a parked panel (rotation, a resized window)
  // would otherwise leave it half off screen with its drag handle out of reach.
  function clampToViewport(): void {
    width = panelWidth();
    viewportHeight = window.innerHeight;
    if (!dmPanel.peerId) return;
    dmPanel.x = Math.max(8, Math.min(dmPanel.x, window.innerWidth - width - 8));
    dmPanel.y = Math.max(8, Math.min(dmPanel.y, window.innerHeight - height - 8));
  }

  $effect(() => {
    // Opening reads as a position of 0,0 before the store is seeded.
    if (dmPanel.peerId && dmPanel.x === 0 && dmPanel.y === 0) {
      Object.assign(dmPanel, defaultPanelPosition());
    }
  });

  $effect(() => {
    // Track the newest message so an arriving reply is not left below the fold.
    if (!list || dmPanel.minimized) return;
    visible.length;
    list.scrollTop = list.scrollHeight;
  });

  async function send(): Promise<void> {
    const body = draft.trim();
    const peerId = dmPanel.peerId;
    if (!body || !peerId || sending) return;
    sending = true;
    const submittedDraft = draft;
    sendError = null;
    try {
      // Explicit peer: the panel is not the conversation the view is on, which
      // is the entire point of it.
      await sendDirectMessage(body, { peerId });
      if (dmPanel.peerId === peerId && draft === submittedDraft) draft = "";
    } catch (err) {
      sendError = err instanceof Error ? err.message : "Could not send; your draft has been kept.";
    } finally {
      sending = false;
    }
  }

  function onKeydown(e: KeyboardEvent): void {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void send();
    }
  }
</script>

<svelte:window onresize={clampToViewport} />

{#if dmPanel.peerId}
  <!--
    z-50 is the app's chrome layer, shared with context menus and dialogs, and
    the panel belongs with them: it floats over a live call without stealing
    focus the way a modal dialog would.
  -->
  <!--
    The same two properties ChatView declares. Miss this and a DM read in the
    floating panel disagrees with the same DM read in the room.
  -->
  <div
    class="fixed z-50 flex flex-col overflow-hidden rounded-lg border border-border bg-card font-(family-name:--chat-font-family) shadow-2xl"
    style="left: {dmPanel.x}px; top: {dmPanel.y}px; width: {width}px; height: {height}px; --chat-font-family: {chatFontStack}"
  >
    <div
      use:draggable={{
        get: () => ({ x: dmPanel.x, y: dmPanel.y }),
        set: (pos) => {
          dmPanel.x = pos.x;
          dmPanel.y = pos.y;
        },
        size: () => ({ width, height }),
      }}
      class="flex h-13 shrink-0 cursor-grab touch-none items-center gap-1 border-b border-border bg-muted/40 px-2 active:cursor-grabbing"
    >
      <span class="min-w-0 flex-1 truncate text-xs font-medium">
        {dmPanel.peerName || "Direct message"}
      </span>

      <Tip text="Open in the DMs tab">
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={() => dmPanel.peerId && onExpand(dmPanel.peerId)}
            aria-label="Expand conversation"
            class="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <CornerUpLeft class="size-3.5 rotate-180" />
          </button>
        {/snippet}
      </Tip>
      <Tip text={dmPanel.minimized ? "Expand panel" : "Collapse to the bar"}>
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={() => (dmPanel.minimized = !dmPanel.minimized)}
            aria-label={dmPanel.minimized ? "Restore panel" : "Minimize panel"}
            class="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <Minus class="size-3.5" />
          </button>
        {/snippet}
      </Tip>
      <Tip text="Close">
        {#snippet children(props)}
          <button
            {...props}
            type="button"
            onclick={closeDmPanel}
            aria-label="Close conversation panel"
            class="inline-flex size-11 shrink-0 cursor-pointer items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-accent-foreground"
          >
            <X class="size-3.5" />
          </button>
        {/snippet}
      </Tip>
    </div>

    {#if !dmPanel.minimized}
      <div
        bind:this={list}
        style="--chat-font-size: {displayPrefs.chatFontSize}px"
        class="flex-1 overflow-y-auto px-2 py-1.5 text-(length:--chat-font-size) leading-normal"
      >
        {#if dmPanel.loading}
          <div role="status" aria-label="Loading messages" class="flex h-full items-center justify-center">
            <div class="size-2 animate-pulse rounded-full bg-muted-foreground"></div>
          </div>
        {:else if visible.length === 0}
          <p class="select-none px-1 py-4 text-center text-xs text-muted-foreground">
            No messages yet. Say something.
          </p>
        {:else}
          {#each visible as msg, i (msg.id)}
            {@const own = msg.senderId === selfId()}
            {#if startsGroup(msg, visible[i - 1])}
              <div
                class="mt-1.5 flex items-baseline gap-1.5 text-xs first:mt-0"
              >
                <span
                  class="truncate font-medium text-(length:--chat-font-size) {own
                    ? 'text-primary'
                    : 'text-foreground'}"
                >
                  {own ? "You" : dmPanel.peerName || msg.senderName}
                </span>
                <span class="shrink-0 text-[10px] text-muted-foreground">
                  {formatTime(msg.timestamp)}
                </span>
              </div>
            {/if}
            <MsgRender
              {msg}
              isOwn={own}
              fileTransfers={transportState.fileTransfers}
              onRequestFileDownload={requestFileDownload}
            />
          {/each}
        {/if}
      </div>

      {#if sendError}<p role="alert" class="px-2 py-1 text-xs text-destructive">{sendError}</p>{/if}
      {#if draft.length > 16384}<p role="status" class="px-2 text-xs text-muted-foreground">This long message will be sent as message.txt.</p>{/if}
      <div class="flex shrink-0 items-center gap-1.5 border-t border-border p-2">
        <input
          bind:value={draft}
          onkeydown={onKeydown}
          placeholder="Message {dmPanel.peerName}"
          aria-label="Message"
          class="min-w-0 flex-1 rounded-md border border-border bg-background px-2 py-1.5 text-xs outline-none focus:border-primary"
        />
        <button
          type="button"
          onclick={send}
          disabled={!draft.trim() || sending}
          aria-label="Send"
          class="inline-flex size-7 shrink-0 cursor-pointer items-center justify-center rounded-md bg-primary text-primary-foreground disabled:cursor-not-allowed disabled:opacity-40"
        >
          <Send class="size-3.5" />
        </button>
      </div>
    {/if}
  </div>
{/if}
