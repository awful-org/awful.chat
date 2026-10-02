<script lang="ts">
  /**
   * How to invite someone to a room, for the invite dialog and the "Room
   * created" card alike.
   *
   * The short code comes first and is one click away: it lets in only the
   * people and only for the time chosen, and dies with that. The permanent
   * link - the room's capability itself, which nothing can expire or count -
   * is still here, folded away below it with what it means said plainly.
   * A QR follows the same order: the short code's link while one is live, the
   * permanent link only when asked for under it.
   */
  import { onDestroy } from "svelte";
  import QRCode from "qrcode";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Check, ChevronDown, Copy, QrCode, Share2 } from "@lucide/svelte";
  import ShortCodeLimits from "./ShortCodeLimits.svelte";
  import PermanentLinkNotice from "./PermanentLinkNotice.svelte";
  import { cancelShortCode, hostShortCode, liveShortCode, shortCodeLink, shortCodeOutcome } from "$lib/short-codes.svelte";
  import { requireRoomSecurityRelease } from "$lib/room-security/invitation-release";
  import type { RoomSecret } from "$lib/room-security/keys";

  interface Props {
    /** The room's capability; null while it loads. */
    secret: RoomSecret | null;
    /** Its permanent link; empty while it loads. */
    link: string;
    /** Tailwind size for the QR images. */
    qrSize?: string;
  }
  let { secret, link, qrSize = "size-44" }: Props = $props();

  // The code lives in short-codes.svelte.ts, not here: leaving this view
  // leaves it working, and coming back shows it again.
  const live = $derived(secret ? liveShortCode(secret) : null);
  const code = $derived(live?.code ?? "");
  const expiresAt = $derived(live?.expiresAt ?? 0);
  const outcome = $derived(secret && !live ? shortCodeOutcome(secret) : null);

  let busy = $state(false);
  let status = $state("");
  let statusIsError = $state(false);
  let copied = $state<"short" | "link" | null>(null);
  let showPermanent = $state(false);
  let showPermanentQr = $state(false);
  let shortQr = $state("");
  let permanentQr = $state("");
  let now = $state(Date.now());
  let alive = true;
  onDestroy(() => (alive = false));

  const headingId = $props.id();
  const canShare = typeof navigator !== "undefined" && typeof navigator.share === "function";

  function say(message: string, error = false): void {
    status = message;
    statusIsError = error;
  }

  $effect(() => {
    if (!code) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const left = $derived.by(() => {
    const s = Math.max(0, Math.ceil((expiresAt - now) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  });

  /** A QR for a link, or "" while it draws; stale results are dropped. */
  function drawQr(url: string, set: (image: string) => void): () => void {
    let current = true;
    set("");
    void QRCode.toDataURL(url, { width: 280, margin: 2 })
      .then((image) => { if (current) set(image); })
      .catch(() => {});
    return () => { current = false; };
  }
  $effect(() => {
    if (!code) { shortQr = ""; return; }
    return drawQr(shortCodeLink(code), (image) => (shortQr = image));
  });
  $effect(() => {
    if (!link || !showPermanentQr) { permanentQr = ""; return; }
    return drawQr(link, (image) => (permanentQr = image));
  });

  async function getCode(limits: { uses: number; ttlMs: number }): Promise<void> {
    if (busy || !secret) return;
    busy = true;
    say("");
    try {
      requireRoomSecurityRelease();
      await hostShortCode(secret, limits);
    } catch {
      if (alive) say("Couldn't get a short code right now. Try again, or use the permanent link below.", true);
    } finally {
      if (alive) busy = false;
    }
  }

  function cancel(): void {
    if (secret) cancelShortCode(secret);
    say("");
  }

  async function copy(value: string, what: "short" | "link"): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      if (alive) say(what === "short" ? "Couldn't copy. Type the code in instead." : "Couldn't copy. Select the link and copy it.", true);
      return;
    }
    if (!alive) return;
    copied = what;
    say("");
    setTimeout(() => { if (alive && copied === what) copied = null; }, 2000);
  }

  async function share(url: string): Promise<void> {
    try {
      await navigator.share({ url });
    } catch (err) {
      // Dismissing the sheet is not a failure.
      if (alive && (err as Error)?.name !== "AbortError") say("Couldn't open sharing. Copy the link instead.", true);
    }
  }
</script>

<div class="flex flex-col gap-4 font-mono">
  <section class="space-y-3" aria-labelledby={headingId}>
    <div>
      <h3 id={headingId} class="text-xs text-foreground">Short code</h3>
      <p class="text-[11px] leading-relaxed text-muted-foreground">
        Lets in the people you choose, for the time you choose. Your app hands it over, so keep
        Awful.chat open while it's live.
      </p>
    </div>

    {#if code}
      <div class="space-y-2 rounded-lg bg-muted px-3 py-3 text-center">
        {#if shortQr}
          <img
            src={shortQr}
            alt="Short code QR"
            class="mx-auto rounded-lg [image-rendering:pixelated] {qrSize}"
          />
        {:else}
          <div class="mx-auto rounded-lg bg-background/40 {qrSize}" aria-hidden="true"></div>
        {/if}
        <div class="select-all text-lg tracking-widest text-foreground">{code}</div>
        <div class="text-xs text-muted-foreground">
          {#if now >= expiresAt}
            Expired.
          {:else if (live?.uses ?? 1) === 1}
            Works once · {left} left
          {:else}
            {live?.joined ?? 0} of {live?.uses} joined · {left} left
          {/if}
        </div>
        <div class="flex justify-center gap-2">
          <Button
            variant="outline"
            size="sm"
            class="font-mono text-xs cursor-pointer"
            aria-label="Copy short link"
            onclick={() => copy(shortCodeLink(code), "short")}
          >
            {#if copied === "short"}
              <Check class="size-3.5 text-primary" /> Copied
            {:else}
              <Copy class="size-3.5" /> Copy link
            {/if}
          </Button>
          {#if canShare}
            <Button
              variant="outline"
              size="sm"
              class="font-mono text-xs cursor-pointer"
              aria-label="Share short link"
              onclick={() => share(shortCodeLink(code))}
            >
              <Share2 class="size-3.5" /> Share
            </Button>
          {/if}
          <Button
            variant="ghost"
            size="sm"
            class="font-mono text-xs text-muted-foreground cursor-pointer"
            aria-label="Cancel short code"
            onclick={cancel}
          >
            Cancel
          </Button>
        </div>
      </div>
    {:else if secret}
      <ShortCodeLimits {busy} onSubmit={getCode} />
    {:else}
      <div class="h-40 rounded-lg bg-muted" aria-hidden="true"></div>
    {/if}

    <p
      role="status"
      class={status
        ? `text-center text-xs ${statusIsError ? "text-destructive" : "text-muted-foreground"}`
        : outcome ? "text-center text-xs text-muted-foreground" : "sr-only"}
    >{status || outcome || ""}</p>
  </section>

  <section class="border-t border-border pt-3">
    <button
      type="button"
      aria-expanded={showPermanent}
      onclick={() => (showPermanent = !showPermanent)}
      class="flex w-full cursor-pointer items-center justify-between gap-2 text-left text-xs text-muted-foreground hover:text-foreground"
    >
      <span>Permanent link <span class="text-muted-foreground/70">· never expires</span></span>
      <ChevronDown class="size-3.5 shrink-0 transition-transform {showPermanent ? 'rotate-180' : ''}" />
    </button>
    {#if showPermanent}
      <div class="mt-3 space-y-3">
        <PermanentLinkNotice />
        {#if link}
          <div class="flex gap-2">
            <Input
              aria-label="Invitation link"
              readonly
              value={link}
              onclick={(e) => e.currentTarget.select()}
              class="bg-muted border-transparent font-mono text-xs md:text-xs text-muted-foreground"
            />
            <Button
              variant="outline"
              size="icon"
              class="shrink-0 cursor-pointer"
              aria-label="Copy invitation link"
              title={copied === "link" ? "Copied" : "Copy link"}
              onclick={() => copy(link, "link")}
            >
              {#if copied === "link"}
                <Check class="size-4 text-primary" />
              {:else}
                <Copy class="size-4" />
              {/if}
            </Button>
          </div>
          <div class="flex gap-2">
            {#if canShare}
              <Button variant="outline" size="sm" class="flex-1 font-mono text-xs cursor-pointer" onclick={() => share(link)}>
                <Share2 class="size-3.5" /> Share permanent link
              </Button>
            {/if}
            <Button
              variant="ghost"
              size="sm"
              class="flex-1 font-mono text-xs text-muted-foreground cursor-pointer"
              aria-expanded={showPermanentQr}
              onclick={() => (showPermanentQr = !showPermanentQr)}
            >
              <QrCode class="size-3.5" /> {showPermanentQr ? "Hide QR" : "Show QR"}
            </Button>
          </div>
          {#if showPermanentQr}
            {#if permanentQr}
              <img
                src={permanentQr}
                alt="Room invitation QR code"
                class="mx-auto rounded-lg [image-rendering:pixelated] {qrSize}"
              />
            {:else}
              <div class="mx-auto rounded-lg bg-muted {qrSize}" aria-hidden="true"></div>
            {/if}
          {/if}
        {/if}
      </div>
    {/if}
  </section>
</div>
