<script lang="ts">
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import { Tip } from "$lib/components/ui/tooltip";
  import { Check, CircleAlert, Copy, Keyboard, RefreshCw, Share2 } from "@lucide/svelte";
  import { savedRoomInvitationLink, parseSecureInvitation } from "$lib/room-security/invitations";
  import { hostInvitationPairing } from "$lib/invite-pairing";
  import { requireRoomSecurityRelease } from "$lib/room-security/invitation-release";
  import QRCode from "qrcode";
  let { roomCode, open = $bindable(false) }: { roomCode: string; open?: boolean } = $props();
  let link = $state("");
  let qr = $state("");
  let code = $state("");
  let codeExpiresAt = $state(0);
  let status = $state("");
  let statusIsError = $state(false);
  let unavailable = $state(false);
  let copiedWhat = $state<"link" | "code" | null>(null);
  let busy = $state(false);
  let now = $state(Date.now());
  let cancel: (() => void) | undefined;
  let controller: AbortController | undefined;
  let generation = 0;
  const canShare =
    typeof navigator !== "undefined" && typeof navigator.share === "function";
  function say(message: string, error = false) {
    status = message;
    statusIsError = error;
  }
  $effect(() => {
    const room = roomCode;
    if (!open) return;
    const current = ++generation;
    link = qr = code = status = "";
    statusIsError = unavailable = false;
    void savedRoomInvitationLink(window.location.origin, room).then(async value => {
      const image = await QRCode.toDataURL(value, { width: 280, margin: 2 });
      if (current === generation) { link = value; qr = image; }
    }).catch((err) => {
      if (current !== generation) return;
      unavailable = true;
      say(err instanceof Error ? err.message : "This room's invite link is not available.", true);
    });
    return () => { generation++; controller?.abort(); cancel?.(); cancel = undefined; link = qr = code = ""; busy = false; copiedWhat = null; };
  });
  $effect(() => {
    if (!code) return;
    now = Date.now();
    const timer = setInterval(() => (now = Date.now()), 1000);
    return () => clearInterval(timer);
  });
  const codeLeft = $derived.by(() => {
    const s = Math.max(0, Math.ceil((codeExpiresAt - now) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  });
  async function pairing() {
    if (busy || !link) return;
    const current = generation;
    busy = true;
    controller?.abort(); cancel?.(); code = "";
    say("");
    controller = new AbortController();
    try {
      requireRoomSecurityRelease();
      const pair = await hostInvitationPairing(parseSecureInvitation(link), value => { if (current === generation) { say(value); code = ""; } }, controller.signal);
      if (current !== generation) { pair.cancel(); return; }
      cancel = pair.cancel; code = pair.code; codeExpiresAt = pair.expiresAt;
    } catch { if (current === generation) say("Couldn't get a short code right now. Share the link instead.", true); }
    finally { if (current === generation) busy = false; }
  }
  function cancelCode() {
    cancel?.();
    cancel = undefined;
    code = "";
    say("");
  }
  async function copy(value: string, what: "link" | "code") {
    const current = generation;
    try {
      await navigator.clipboard.writeText(value);
      if (current !== generation) return;
      copiedWhat = what;
      say("");
      setTimeout(() => { if (current === generation && copiedWhat === what) copiedWhat = null; }, 2000);
    }
    catch { if (current === generation) say(what === "link" ? "Couldn't copy. Select the link and copy it." : "Couldn't copy. Select the code and copy it.", true); }
  }
  async function share() {
    const current = generation;
    try { await navigator.share({ url: link }); }
    catch (err) { if (current === generation && (err as Error).name !== "AbortError") say("Couldn't open sharing. Copy the link instead.", true); }
  }
</script>

<Dialog bind:open>
  <DialogContent
    class="bg-card border-border text-card-foreground font-mono w-full sm:max-w-sm flex flex-col gap-0 p-0 max-h-[calc(100dvh-2rem)] overflow-hidden"
  >
    <DialogHeader class="px-6 py-4 border-b border-border shrink-0">
      <DialogTitle class="font-mono text-base font-semibold">Invite to this room</DialogTitle>
      <DialogDescription class="text-xs">
        Anyone with this link or QR code can join.
      </DialogDescription>
    </DialogHeader>

    <div class="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
      {#if qr}
        <img
          src={qr}
          alt="Room invitation QR code"
          class="mx-auto size-50 rounded-lg [image-rendering:pixelated]"
        />
      {:else}
        <div class="mx-auto flex size-50 items-center justify-center rounded-lg bg-muted">
          {#if unavailable}
            <CircleAlert class="size-8 text-destructive" />
          {:else}
            <RefreshCw class="size-8 animate-spin text-muted-foreground" />
          {/if}
        </div>
      {/if}

      {#if link}
        <div class="flex gap-2">
          <Input
            aria-label="Invitation link"
            readonly
            value={link}
            onclick={(e) => e.currentTarget.select()}
            class="bg-muted border-transparent font-mono text-xs md:text-xs text-muted-foreground"
          />
          <Tip text={copiedWhat === "link" ? "Copied" : "Copy link"}>
            {#snippet children(props)}
              <Button
                {...props}
                variant="outline"
                size="icon"
                class="shrink-0 cursor-pointer"
                aria-label="Copy invitation link"
                onclick={() => copy(link, "link")}
              >
                {#if copiedWhat === "link"}
                  <Check class="size-4 text-primary" />
                {:else}
                  <Copy class="size-4" />
                {/if}
              </Button>
            {/snippet}
          </Tip>
        </div>
        {#if canShare}
          <Button variant="outline" class="w-full font-mono cursor-pointer" onclick={share}>
            <Share2 class="size-4" />
            Share invite link
          </Button>
        {/if}
      {/if}

      <div class="space-y-2">
        {#if code}
          <div class="rounded-lg bg-muted px-3 py-2 text-center">
            <div class="select-all font-mono text-lg tracking-widest text-foreground">{code}</div>
            <div class="mt-1 text-xs text-muted-foreground">
              Works once · {codeLeft} left · keep this open
            </div>
            <div class="mt-2 flex justify-center gap-2">
              <Button
                variant="outline"
                size="sm"
                class="font-mono text-xs cursor-pointer"
                aria-label="Copy short code"
                onclick={() => copy(code, "code")}
              >
                {#if copiedWhat === "code"}
                  <Check class="size-3.5 text-primary" /> Copied
                {:else}
                  <Copy class="size-3.5" /> Copy
                {/if}
              </Button>
              <Button
                variant="ghost"
                size="sm"
                class="font-mono text-xs text-muted-foreground cursor-pointer"
                aria-label="Cancel short code"
                onclick={cancelCode}
              >
                Cancel
              </Button>
            </div>
          </div>
        {:else if link}
          <Button
            variant="ghost"
            disabled={busy}
            class="w-full font-mono text-xs text-muted-foreground cursor-pointer"
            onclick={pairing}
          >
            <Keyboard class="size-3.5" />
            {busy ? "Getting a short code..." : "Can't scan? Get a short code"}
          </Button>
        {/if}
        <p
          role="status"
          class={status
            ? `text-center text-xs ${statusIsError ? "text-destructive" : "text-muted-foreground"}`
            : "sr-only"}
        >{status}</p>
      </div>
    </div>
  </DialogContent>
</Dialog>
