<script lang="ts">
  /**
   * A DM call's card (call-card.ts): one per call, its end folded in by the
   * conversation view. The message header above it says who started it.
   */
  import { Phone, PhoneMissed } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button/index.js";
  import { callCardState, formatCallDuration, parseCallCard, type CallCardPayload } from "$lib/call-card";
  import { callStartSeen, joinedDmCall } from "$lib/dm-call-joined";
  import { transportState } from "$lib/transport/transport.svelte";
  import { joinCall, leaveCall } from "$lib/transport/call.svelte";
  import type { Message } from "$lib/types/message";

  let {
    msg,
    isOwn,
    callEnd = null,
    callOpen = false,
  }: {
    msg: Message;
    isOwn: boolean;
    callEnd?: CallCardPayload | null;
    /** The DM's newest call with no end yet: the only card a live call can be. */
    callOpen?: boolean;
  } = $props();

  const card = $derived(parseCallCard(msg.content));
  const inThisCall = $derived(transportState.inCall && transportState.callRoomCode === msg.roomCode);
  /** Anyone - us or them - is in this DM's call right now. */
  const ongoing = $derived(
    callOpen &&
      (inThisCall || [...transportState.callPeerRooms.values()].includes(msg.roomCode))
  );
  const shown = $derived(
    card?.phase === "end"
      // An end whose start is not held stands alone: its own startedAt
      // gives the length, and this device's part says missed or not.
      ? callCardState({
          end: card,
          ongoing: false,
          joined: joinedDmCall(card.callId),
          mine: false,
        })
      : callCardState({
          start: card ?? undefined,
          end: callEnd ?? undefined,
          ongoing,
          joined: !!card && joinedDmCall(card.callId),
          mine: isOwn,
        })
  );

  /**
   * When an ongoing call began, on this device's clock where it saw the start
   * arrive live: the card's own time is the caller's clock, and one a few
   * minutes off ran the timer that far ahead or held it at 0:00.
   */
  const since = $derived(
    shown.kind === "ongoing" ? ((card && callStartSeen(card.callId)) ?? shown.since) : 0
  );

  let now = $state(Date.now());
  $effect(() => {
    if (shown.kind !== "ongoing") return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });

  function clock(ms: number): string {
    const s = Math.max(0, Math.floor(ms / 1000));
    const h = Math.floor(s / 3600);
    const mm = String(Math.floor((s % 3600) / 60)).padStart(h ? 2 : 1, "0");
    const ss = String(s % 60).padStart(2, "0");
    return h ? `${h}:${mm}:${ss}` : `${mm}:${ss}`;
  }

  // joinCall is a no-op while any call is up, so joining this one means
  // leaving the other first (as VoiceVideoCallView does).
  function joinFromCard(): void {
    if (transportState.inCall) leaveCall();
    void joinCall();
  }

  /** Join from the card only where joining means this DM: it is on screen. */
  const canJoin = $derived(
    shown.kind === "ongoing" && !inThisCall && transportState.roomCode === msg.roomCode
  );
</script>

<div
  class="inline-flex max-w-full items-center gap-3 rounded-lg border px-3 py-2 font-mono text-xs {shown.kind === 'missed'
    ? 'border-destructive/40 text-destructive'
    : shown.kind === 'ongoing'
      ? 'border-primary/50 text-foreground'
      : 'border-border text-muted-foreground'}"
>
  {#if shown.kind === "missed"}
    <PhoneMissed class="size-4 shrink-0" />
    <span>Missed call</span>
  {:else if shown.kind === "ongoing"}
    <Phone class="size-4 shrink-0 text-primary" />
    <span>Call in progress · <span class="tabular-nums">{clock(now - since)}</span></span>
    {#if canJoin}
      <Button size="sm" class="h-7 font-mono text-xs" onclick={joinFromCard}>Join</Button>
    {/if}
  {:else}
    <Phone class="size-4 shrink-0" />
    <span>
      {#if shown.kind === "ended"}
        Call · {formatCallDuration(shown.duration)}
      {:else}
        Call ended
      {/if}
    </span>
  {/if}
</div>
