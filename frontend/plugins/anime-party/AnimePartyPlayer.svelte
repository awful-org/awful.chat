<script lang="ts">
  /**
   * The shared playback surface: file pickers, the `<video>` element, and
   * the party's synced transport controls. Both the card and the call tile
   * mount this - the only difference between those two surfaces is the
   * chrome around it (join/leave vs click-to-join).
   *
   * No file's bytes are ever read by this component beyond what
   * `URL.createObjectURL` needs locally. Nothing here ever calls
   * `host.sendCard`/`sendUpdate` with a File, a Blob, or their contents.
   */
  import { onDestroy, onMount, untrack } from "svelte";
  import {
    AlertTriangle,
    Captions,
    Pause,
    Play,
    SkipForward,
    Upload,
    Volume2,
  } from "@lucide/svelte";
  import type { HostApi } from "$lib/plugins/api";
  import { Tip } from "$lib/plugins/ui";
  import {
    estimateClock,
    projectPosition,
    decideCorrection,
    type ClockEstimate,
    type ClockSample,
    type Correction,
    type WatchTick,
  } from "$lib/plugins/watch";
  import { assessFile, mediaErrorMessage, type FileAssessment } from "./playback";
  import type { AnimePartyState } from "./logic";

  let {
    card,
    party,
    host,
    chromeVisible = true,
  }: {
    card: { id: string };
    party: AnimePartyState;
    host: HostApi;
    chromeVisible?: boolean;
  } = $props();

  // untrack: our own DID never changes across this component's life, so
  // this is deliberately a one-time read, not a tracked dependency - the
  // same pattern the ecosystem's watch-together card uses for the same
  // host.selfDid() call.
  const selfDid = untrack(() => host.selfDid());
  const isOwner = $derived(party.ownerDid === selfDid);

  let videoEl: HTMLVideoElement | undefined = $state();
  let fileName = $state<string | null>(null);
  let subtitleName = $state<string | null>(null);
  let assessment = $state<FileAssessment>({ verdict: "unknown", reason: null });
  let playbackError = $state<string | null>(null);
  let volume = $state(1);

  let objectUrl = $state<string | null>(null);
  let subtitleUrl = $state<string | null>(null);
  let seq = 0;
  let clockSamples: ClockSample[] = [];
  let clockEstimate = $state<ClockEstimate>({ offsetMs: 0, rttMs: 0, samples: 0 });
  let pendingResync: { id: string; sentAt: number } | null = null;
  const answeredResyncIds = new Set<string>();
  // untrack: seeded once on purpose (compared against the live party.episode
  // inside the effect below), the same "seed once, then own it" pattern
  // MusicCard uses for its localPosition seed.
  let lastSeenEpisode = untrack(() => party.episode);

  onMount(() => {
    void host.storage.get("volume").then((v) => {
      if (typeof v === "number" && v >= 0 && v <= 1) volume = v;
    });
    if (!isOwner) requestResync();
  });

  onDestroy(() => {
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    if (subtitleUrl) URL.revokeObjectURL(subtitleUrl);
  });

  // A new episode is nobody's file until they open it again - carrying the
  // old object URL forward would show episode N+1's controls over episode
  // N's picture.
  $effect(() => {
    if (party.episode === lastSeenEpisode) return;
    lastSeenEpisode = party.episode;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    objectUrl = null;
    fileName = null;
    assessment = { verdict: "unknown", reason: null };
    playbackError = null;
    if (videoEl) videoEl.removeAttribute("src");
  });

  $effect(() => {
    if (videoEl) videoEl.volume = volume;
  });

  // A paused/played durable-state change reaches every member immediately,
  // rather than waiting for the next heartbeat tick.
  $effect(() => {
    if (isOwner || !videoEl || !objectUrl) return;
    if (party.paused && !videoEl.paused) videoEl.pause();
    if (!party.paused && videoEl.paused) void videoEl.play().catch(() => {});
  });

  function buildTick(): WatchTick {
    seq += 1;
    return {
      paused: videoEl?.paused ?? party.paused,
      position: videoEl?.currentTime ?? 0,
      atMs: Date.now(),
      rate: 1,
      seq,
    };
  }

  function sendTick(): void {
    void host.sendUpdate(card.id, { action: "tick", tick: buildTick() }, { ephemeral: true });
  }

  // The owner's heartbeat: how every other member's reconciliation loop
  // learns where playback actually is.
  $effect(() => {
    if (!isOwner || party.closed) return;
    const timer = setInterval(() => {
      if (videoEl && objectUrl) sendTick();
    }, 1000);
    return () => clearInterval(timer);
  });

  // Answer any late-joiner sync request nobody has answered yet.
  $effect(() => {
    if (!isOwner || !party.syncRequest) return;
    const req = party.syncRequest;
    if (answeredResyncIds.has(req.id)) return;
    answeredResyncIds.add(req.id);
    void host.sendUpdate(card.id, {
      action: "resync-response",
      targetDid: req.requesterDid,
      requestId: req.id,
      tick: buildTick(),
    });
  });

  function requestResync(): void {
    const requestId = crypto.randomUUID();
    pendingResync = { id: requestId, sentAt: Date.now() };
    void host.sendUpdate(card.id, { action: "resync-request", requestId });
  }

  // The late-joiner round trip: one request, one response, no per-frame
  // traffic. The response's timestamp plus our own send/receive times give
  // a single NTP-style clock sample (t1 and t2 coincide because the owner
  // reports one instant, not a distinct receive-then-send pair).
  $effect(() => {
    const resp = party.syncResponse;
    if (!resp || resp.targetDid !== selfDid || !pendingResync || resp.id !== pendingResync.id)
      return;
    const t3 = Date.now();
    const sample: ClockSample = {
      t0: pendingResync.sentAt,
      t1: resp.tick.atMs,
      t2: resp.tick.atMs,
      t3,
    };
    clockSamples = [...clockSamples, sample].slice(-8);
    clockEstimate = estimateClock(clockSamples);
    pendingResync = null;
    if (videoEl && objectUrl) {
      videoEl.currentTime = projectPosition(resp.tick, Date.now(), clockEstimate.offsetMs);
      if (resp.tick.paused) videoEl.pause();
      else void videoEl.play().catch(() => {});
    }
  });

  function applyCorrection(correction: Correction): void {
    if (!videoEl) return;
    switch (correction.action) {
      case "seek":
        videoEl.currentTime = correction.targetPosition;
        videoEl.playbackRate = 1;
        break;
      case "rate":
        videoEl.playbackRate = correction.rate;
        break;
      case "pause":
        videoEl.playbackRate = 1;
        videoEl.pause();
        break;
      case "resume":
        videoEl.playbackRate = 1;
        void videoEl.play().catch(() => {});
        break;
      case "none":
        videoEl.playbackRate = 1;
        break;
    }
  }

  // The continuous half of sync: small drift is absorbed by nudging the
  // rate, large drift by seeking - the control law itself lives in
  // $lib/plugins/watch, this just feeds it our local player state.
  $effect(() => {
    if (isOwner || party.closed) return;
    const timer = setInterval(() => {
      if (!videoEl || !objectUrl || !party.lastTick) return;
      const local = {
        position: videoEl.currentTime,
        paused: videoEl.paused,
        rate: videoEl.playbackRate,
      };
      applyCorrection(decideCorrection(local, party.lastTick, Date.now(), clockEstimate.offsetMs));
    }, 1000);
    return () => clearInterval(timer);
  });

  function onFilePick(e: Event): void {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    if (objectUrl) URL.revokeObjectURL(objectUrl);
    playbackError = null;
    fileName = file.name;
    assessment = assessFile(file.name);
    if (assessment.verdict === "unplayable") {
      objectUrl = null;
      videoEl?.removeAttribute("src");
      return;
    }
    objectUrl = URL.createObjectURL(file);
    if (videoEl) videoEl.src = objectUrl;
  }

  function onSubtitlePick(e: Event): void {
    const file = (e.currentTarget as HTMLInputElement).files?.[0];
    if (!file) return;
    if (subtitleUrl) URL.revokeObjectURL(subtitleUrl);
    subtitleName = file.name;
    subtitleUrl = URL.createObjectURL(file);
  }

  function onVideoError(): void {
    playbackError = mediaErrorMessage(videoEl?.error?.code ?? null);
  }

  function onVolumeInput(e: Event): void {
    volume = Number((e.currentTarget as HTMLInputElement).value);
    void host.storage.set("volume", volume);
  }

  async function togglePlay(): Promise<void> {
    if (!isOwner) return;
    const willPause = !party.paused;
    await host.sendUpdate(card.id, { action: willPause ? "pause" : "play" });
    if (videoEl) {
      if (willPause) videoEl.pause();
      else void videoEl.play().catch(() => {});
    }
    sendTick();
  }

  function onSeekCommit(): void {
    if (isOwner) sendTick();
  }

  async function nextEpisode(): Promise<void> {
    if (!isOwner) return;
    await host.sendUpdate(card.id, { action: "select-episode", episode: party.episode + 1 });
  }

  const atLastEpisode = $derived(
    party.episodeCount !== null && party.episode >= party.episodeCount
  );
</script>

<div class="flex w-full flex-col gap-2">
  <div class="relative overflow-hidden rounded-md bg-black">
    <video
      bind:this={videoEl}
      class="aspect-video w-full bg-black"
      controls={false}
      onerror={onVideoError}
      onseeked={onSeekCommit}
    >
      {#if subtitleUrl}
        <track kind="subtitles" src={subtitleUrl} label={subtitleName ?? "Subtitles"} default />
      {/if}
    </video>
    {#if !objectUrl}
      <div class="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-black/60 p-4 text-center">
        <label
          class="flex cursor-pointer items-center gap-2 rounded-md bg-primary px-3 py-1.5 text-xs font-medium text-primary-foreground"
        >
          <Upload class="size-3.5" />
          Open episode {party.episode}
          <input type="file" accept="video/*" class="hidden" onchange={onFilePick} />
        </label>
        <p class="max-w-xs text-[11px] text-white/70">
          Your file stays on your device. Nothing is uploaded to the room.
        </p>
      </div>
    {/if}
  </div>

  {#if assessment.reason}
    <div
      class="flex items-start gap-2 rounded-md border border-border bg-muted p-2 text-[11px] {assessment.verdict === 'unplayable' ? 'text-destructive' : 'text-muted-foreground'}"
    >
      <AlertTriangle class="mt-0.5 size-3.5 shrink-0" />
      <span>{assessment.reason}</span>
    </div>
  {/if}
  {#if playbackError}
    <div class="flex items-start gap-2 rounded-md border border-border bg-muted p-2 text-[11px] text-destructive">
      <AlertTriangle class="mt-0.5 size-3.5 shrink-0" />
      <span>{playbackError}</span>
    </div>
  {/if}

  <div
    class="flex items-center gap-2 {chromeVisible ? '' : 'opacity-60'}"
  >
    <Tip text={isOwner ? (party.paused ? "Play" : "Pause") : "Only the host controls playback"}>
      {#snippet children(props)}
        <button
          {...props}
          onclick={togglePlay}
          disabled={!isOwner}
          aria-label={party.paused ? "Play" : "Pause"}
          class="rounded-md border border-border p-1.5 hover:bg-accent disabled:opacity-40"
        >
          {#if party.paused}<Play class="size-3.5" />{:else}<Pause class="size-3.5" />{/if}
        </button>
      {/snippet}
    </Tip>

    <Tip text={atLastEpisode ? "No more episodes" : "Next episode"}>
      {#snippet children(props)}
        <button
          {...props}
          onclick={nextEpisode}
          disabled={!isOwner || atLastEpisode}
          aria-label="Next episode"
          class="rounded-md border border-border p-1.5 hover:bg-accent disabled:opacity-40"
        >
          <SkipForward class="size-3.5" />
        </button>
      {/snippet}
    </Tip>

    <span class="font-mono text-[11px] text-muted-foreground">
      Episode {party.episode}{party.episodeCount ? ` / ${party.episodeCount}` : ""}
    </span>

    <div class="ml-auto flex items-center gap-1.5">
      <Volume2 class="size-3.5 text-muted-foreground" />
      <input
        type="range"
        min="0"
        max="1"
        step="0.05"
        value={volume}
        oninput={onVolumeInput}
        class="w-16"
        aria-label="Volume"
      />
    </div>

    <label class="flex cursor-pointer items-center gap-1 rounded-md border border-border px-2 py-1 text-[11px] hover:bg-accent">
      <Captions class="size-3.5" />
      {subtitleName ?? "Subtitles (.vtt)"}
      <input type="file" accept=".vtt,text/vtt" class="hidden" onchange={onSubtitlePick} />
    </label>
  </div>

  {#if fileName}
    <p class="truncate font-mono text-[10px] text-muted-foreground">Your file: {fileName}</p>
  {/if}
</div>
