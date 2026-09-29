<script lang="ts">
  import { requireRoomSecurityRelease } from "$lib/room-security/invitation-release";
  import GifImage from "./GifImage.svelte";
  import { mediaPrefs } from "$lib/media-prefs.svelte";
  import { newRoomCode } from "$lib/room-code";
  import { parseJoinInput } from "$lib/invite";
  import { hostInvitationPairing, joinInvitationPairing } from "$lib/invite-pairing";
  import { parseSecureInvitation } from "$lib/room-security/invitations";
  import { onDestroy, tick } from "svelte";
  import QRCode from "qrcode";
  import { Check, Clipboard, Copy, LogIn, Menu, Plus, Share2 } from "@lucide/svelte";
  import { viewportHeight } from "$lib/actions/viewport-height";
  import { Button } from "$lib/components/ui/button";
  import { Input } from "$lib/components/ui/input";
  import {
    Card,
    CardContent,
    CardDescription,
    CardHeader,
    CardTitle,
  } from "$lib/components/ui/card";
  import { profileStore, loadProfile, saveName } from "$lib/profile.svelte";
  import AvatarPickerDialog from "$lib/components/AvatarPickerDialog.svelte";
  import { transportState } from "$lib/transport/transport.svelte";
  import { displayPrefs } from "$lib/display-prefs.svelte";

  interface Props {
    onJoin: (roomCode: string, displayName: string, roomName?: string) => void | Promise<void>;
    error?: string | null;
    toggleSidebar?: () => void;
    /** Inside AppView's modal: no full-page wrapper, the modal scrolls. */
    inDialog?: boolean;
  }

  let { onJoin, error = null, toggleSidebar, inDialog = false }: Props = $props();

  let roomName = $state("");
  let joinCode = $state("");
  let createdCode = $state<string | null>(null);
  // `/r/#<code>`, not `/r/<code>`: a fragment never reaches the server, so
  // the membership secret stays out of access logs and out of the Referer
  // of every link the room page later opens.
  const createdLink = $derived(
    createdCode ? `${window.location.origin}/r/#${createdCode}` : ""
  );
  let copied = $state(false);
  let qr = $state("");
  const qrSize = $derived(inDialog ? "size-50" : "size-60");
  let cancelPairing: (() => void) | undefined;
  let hostController: AbortController | undefined;
  let joinController: AbortController | undefined;
  let alive = true;
  let pairingBusy = $state(false);
  onDestroy(() => { alive = false; hostController?.abort(); cancelPairing?.(); joinController?.abort(); });
  // Online OPAQUE pairing is single-use and only works while this view is open.
  let shortCode = $state<string | null>(null);
  let shortCodeExpiresAt = $state(0);
  let now = $state(Date.now());
  $effect(() => {
    if (!shortCode) return;
    now = Date.now();
    const timer = setInterval(() => now = Date.now(), 1000);
    return () => clearInterval(timer);
  });
  const shortCodeLeft = $derived.by(() => {
    const s = Math.max(0, Math.ceil((shortCodeExpiresAt - now) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  });
  let shortCodeError = $state<string | null>(null);
  // Outcomes reported by the pairing ("delivered", "expired"): not errors.
  let pairingStatus = $state<string | null>(null);
  let shortCopied = $state(false);
  let copyMenuOpen = $state(false);
  let joinError = $state<string | null>(null);
  // Only a short-code join waits on the inviter, so only it can be cancelled.
  let pairingJoin = $state(false);
  $effect(() => { joinCode; joinController?.abort(); joinError = null; });
  let avatarDialogOpen = $state(false);

  let { relayConnected } = $derived(transportState);

  $effect(() => {
    loadProfile();
  });

  let creating = $state(false);
  let joining = $state(false);
  let joinCreatedButton = $state<HTMLElement | null>(null);

  async function handleCreate() {
    if (creating) return;
    creating = true;
    try {
      await saveName(profileStore.nickname);
      requireRoomSecurityRelease();
      const code = newRoomCode();
      createdCode = code;
      copied = false;
      shortCode = null;
      shortCodeExpiresAt = 0;
      shortCodeError = null;
      pairingStatus = null;
      // The focused Create button is gone; joining is the next step.
      void tick().then(() => joinCreatedButton?.focus());
      qr = await QRCode.toDataURL(`${window.location.origin}/r/#${code}`, { width: 280, margin: 2 });
    } catch (err) {
      joinError = err instanceof Error ? err.message : "Could not create the room";
    } finally {
      creating = false;
    }
  }

  async function handleJoinCreated() {
    if (!createdCode || joining) return;
    joining = true;
    try {
      await saveName(profileStore.nickname);
      await onJoin(
        createdCode,
        profileStore.nickname || "Anonymous",
        roomName.trim() || undefined
      );
      hostController?.abort(); cancelPairing?.();
      createdCode = null;
    } catch (err) {
      shortCodeError = err instanceof Error ? err.message : "Could not open the room";
    } finally {
      joining = false;
    }
  }

  async function handleJoin() {
    if (!joinCode.trim() || joining) return;
    joining = true;
    joinError = null;
    const controller = new AbortController();
    joinController = controller;
    const input = joinCode;
    try {
      requireRoomSecurityRelease();
      await saveName(profileStore.nickname);
      if (!alive || controller.signal.aborted) return;
      const parsed = parseJoinInput(input);
      if (parsed.kind === "invalid") {
        joinError = "Enter a valid room link or code";
        return;
      }
      let code = parsed.code;
      if (parsed.kind === "pairing") {
        pairingJoin = true;
        code = await joinInvitationPairing(code, controller.signal);
      }
      if (!alive || controller.signal.aborted) return;
      await onJoin(code, profileStore.nickname || "Anonymous");
    } catch (err) {
      if (alive && !controller.signal.aborted && joinController === controller) {
        joinError = err instanceof Error ? err.message : "Could not join the room";
      }
    } finally {
      if (joinController === controller) {
        joining = false;
        pairingJoin = false;
      }
    }
  }

  async function handleCopyLink() {
    copyMenuOpen = false;
    await handleCopy(createdCode!);
  }

  // Mint on first use, then copy. The code stays on screen afterwards so it
  // can be read aloud, which is the point of it.
  async function handleCopyShort() {
    if (pairingBusy || !createdCode) return;
    pairingBusy = true;
    copyMenuOpen = false;
    shortCodeError = null;
    pairingStatus = null;
    try {
      if (!shortCode || Date.now() >= shortCodeExpiresAt) {
        cancelPairing?.();
        hostController?.abort();
        hostController = new AbortController();
        const made = await hostInvitationPairing(parseSecureInvitation(createdCode), value => { if (alive) { pairingStatus = value; shortCode = null; } }, hostController.signal);
        if (!alive) { made.cancel(); return; }
        cancelPairing = made.cancel;
        shortCode = made.code;
        shortCodeExpiresAt = made.expiresAt;
      }
    } catch {
      shortCodeError = "Couldn't get a short code right now. Share the link instead.";
      return;
    } finally { pairingBusy = false; }
    try { await navigator.clipboard.writeText(shortCode!); shortCopied = true; }
    catch { shortCodeError = "Couldn't copy. Select the code below and copy it."; }
    setTimeout(() => (shortCopied = false), 2000);
  }

  // The OS share sheet, where there is one. Only offered when the browser
  // actually has it, or the menu would carry two entries that do the same
  // thing; the catch still falls back to the clipboard.
  const canShare = $derived(
    typeof navigator !== "undefined" && typeof navigator.share === "function"
  );

  async function handleShareLink() {
    copyMenuOpen = false;
    try {
      await navigator.share({ url: createdLink });
    } catch (err) {
      // Dismissing the sheet is not a failure and must not silently copy
      // something the user decided not to send.
      if ((err as Error)?.name === "AbortError") return;
      await handleCopy(createdCode!);
    }
  }

  async function handleCopy(code: string) {
    // Fragment form - see createdLink.
    try { await navigator.clipboard.writeText(`${window.location.origin}/r/#${code}`); }
    catch { shortCodeError = "Couldn't copy. Select the link above and copy it."; return; }
    copied = true;
    setTimeout(() => (copied = false), 2000);
  }

  async function handlePaste() {
    try {
      const text = await navigator.clipboard.readText();
      joinCode = text.trim();
    } catch {
      // clipboard denied
    }
  }

  const initial = $derived(
    (profileStore.nickname || "?").charAt(0).toUpperCase()
  );
</script>

{#snippet card()}
  {#if !createdCode}
    <Card class="m-auto w-full max-w-sm bg-card border-border text-card-foreground">
      <CardHeader>
        <div class="flex items-center justify-between">
          <div>
            <CardTitle class="text-xl font-mono text-foreground"
              >Awful.chat</CardTitle
            >
            <CardDescription class="text-xs mt-1 text-muted-foreground">
              Private rooms, peer-to-peer
            </CardDescription>
          </div>

          <!-- Connection status pill: always shown, not gated on showConnectionInfo.
               That setting controls only the floating panel on the right. -->
          {#if relayConnected}
            <div
              class="flex items-center gap-1.5 px-2 py-1 rounded-full bg-muted text-xs"
            >
              <span class="size-2 rounded-full bg-primary"></span>
              <span class="text-muted-foreground">Connected</span>
            </div>
          {:else}
            <div
              class="flex items-center gap-1.5 px-2 py-1 rounded-full bg-amber-300/10 text-xs"
            >
              <span class="size-2 rounded-full bg-amber-300"></span>
              <span class="text-muted-foreground">Connecting...</span>
            </div>
          {/if}
        </div>
      </CardHeader>

      <CardContent class="grid gap-6">
        {#if error || joinError}
          <div
            id="room-join-error" role="alert"
            class="rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm text-destructive"
          >
            {error ?? joinError}
          </div>
        {/if}

        <div class="flex flex-col items-center gap-3">
          <button
            type="button"
            onclick={() => {
              avatarDialogOpen = true;
            }}
            aria-label="Change profile picture"
            class="relative group flex size-30 items-center justify-center rounded-full overflow-hidden bg-primary/20 hover:ring-2 hover:ring-primary/50 transition-all cursor-pointer focus:outline-none focus:ring-2 focus:ring-primary"
          >
            {#if profileStore.avatarUrl}
              <GifImage
                src={profileStore.avatarUrl}
                alt="Avatar"
                class="size-full object-cover"
                animate={mediaPrefs.gifAutoplay ? true : "hover"}
              />
            {:else}
              <span
                class="text-2xl font-semibold text-primary font-mono select-none"
                >{initial}</span
              >
            {/if}
            <div
              class="absolute inset-0 rounded-full flex items-center justify-center bg-black/50 opacity-0 group-hover:opacity-100 transition-opacity"
            >
              <span class="text-white text-xs font-mono">Change</span>
            </div>
          </button>
          <label for="display-name" class="text-xs font-medium">Display name</label>
          <Input
            id="display-name" aria-label="Display name" autocomplete="nickname"
            value={profileStore.nickname}
            oninput={(e) => {
              profileStore.nickname = (e.target as HTMLInputElement).value;
            }}
            onchange={(e) => {
              void saveName((e.target as HTMLInputElement).value).catch((err) => {
                joinError = err instanceof Error ? err.message : "Could not save your display name";
              });
            }}
            placeholder="Your display name"
            class="bg-background border-input text-foreground placeholder:text-muted-foreground font-mono text-center focus-visible:ring-ring"
          />
        </div>

        <div class="grid gap-2">
          <label for="room-name" class="text-sm font-medium">Room name <span class="text-muted-foreground">(optional)</span></label>
          <Input
            id="room-name" autocomplete="off"
            bind:value={roomName}
            placeholder="Room name (optional)"
            class="bg-background border-input text-foreground placeholder:text-muted-foreground font-mono focus-visible:ring-ring"
          />
          <Button
            onclick={handleCreate}
            disabled={creating}
            class="bg-primary hover:bg-primary/90 text-primary-foreground font-mono cursor-pointer"
          >
            <Plus class="size-4" />
            {creating ? "Creating..." : "Create room"}
          </Button>
        </div>

        <div class="relative">
          <div class="absolute inset-0 flex items-center">
            <span class="w-full border-t border-border"></span>
          </div>
          <div class="relative flex justify-center text-xs uppercase">
            <span class="bg-card px-2 text-muted-foreground">or</span>
          </div>
        </div>

        <div class="grid gap-2">
          <label for="join-code" class="text-sm font-medium">Room link or code</label>
          <div class="relative">
            <Input
              id="join-code" autocomplete="off" aria-describedby={joinError ? "room-join-error" : undefined} aria-invalid={joinError ? "true" : undefined}
              bind:value={joinCode}
              placeholder="Invite link or short code"
              class="bg-background border-input text-foreground placeholder:text-muted-foreground font-mono pr-10 focus-visible:ring-ring"
            />
            <button
              type="button"
              onclick={handlePaste}
              class="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground cursor-pointer"
              aria-label="Paste room code"
            >
              <Clipboard class="size-4" />
            </button>
          </div>
          <Button
            variant="outline"
            onclick={handleJoin}
            disabled={!joinCode.trim() || joining}
            class="border-border text-muted-foreground hover:text-foreground hover:bg-muted font-mono cursor-pointer disabled:opacity-30"
          >
            <LogIn class="size-4 mr-1" />
            {joining ? "Joining..." : "Join room"}
          </Button>
          {#if pairingJoin}
            <Button
              variant="ghost"
              onclick={() => joinController?.abort()}
              class="font-mono text-muted-foreground hover:text-foreground cursor-pointer"
            >
              Cancel
            </Button>
          {/if}
        </div>
      </CardContent>
    </Card>
  {:else}
    <Card class="m-auto w-full max-w-sm bg-card border-border text-card-foreground">
      <CardHeader>
        <CardTitle class="font-mono text-foreground">Room created</CardTitle>
        <CardDescription class="text-muted-foreground">
          Anyone with this link or QR code can join.
        </CardDescription>
      </CardHeader>
      <!-- grid-cols-1 (minmax(0, 1fr)) so the long link cannot widen the card. -->
      <CardContent class="grid grid-cols-1 gap-4">
        {#if qr}
          <img
            src={qr}
            alt="Room invitation QR code"
            class="mx-auto rounded-lg [image-rendering:pixelated] {qrSize}"
          />
        {:else}
          <div class="mx-auto rounded-lg bg-muted {qrSize}" aria-hidden="true"></div>
        {/if}
        <div class="relative">
          <!-- A field, so the link can be selected when the clipboard is refused. -->
          <Input
            aria-label="Invitation link"
            readonly
            value={createdLink}
            onclick={(e) => e.currentTarget.select()}
            class="bg-muted border-transparent font-mono text-xs md:text-xs text-muted-foreground pr-10 focus-visible:ring-ring"
          />
          <div class="absolute right-2 top-1/2 -translate-y-1/2" data-copy-menu>
            <button
              type="button"
              onclick={() => (copyMenuOpen = !copyMenuOpen)}
              class="flex rounded-sm text-muted-foreground hover:text-foreground cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              aria-label="Copy"
              aria-haspopup="menu"
              aria-expanded={copyMenuOpen}
            >
              {#if copied || shortCopied}
                <Check class="size-4 text-primary" />
              {:else}
                <Copy class="size-4" />
              {/if}
            </button>
            {#if copyMenuOpen}
              <div
                role="menu"
                class="absolute right-0 top-full mt-2 z-10 w-56 rounded-lg border border-border bg-popover text-popover-foreground shadow-md p-1"
              >
                <button
                  type="button"
                  role="menuitem"
                  onclick={handleCopyLink}
                  class="w-full text-left rounded-md px-2 py-1.5 text-sm hover:bg-muted cursor-pointer"
                >
                  Copy link
                </button>
                {#if canShare}
                  <button
                    type="button"
                    role="menuitem"
                    onclick={handleShareLink}
                    class="flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-muted cursor-pointer"
                  >
                    <Share2 class="size-3.5" />
                    Share link
                  </button>
                {/if}
                <button
                  type="button"
                  role="menuitem"
                  onclick={handleCopyShort}
                  disabled={pairingBusy}
                  class="w-full text-left rounded-md px-2 py-1.5 text-sm hover:bg-muted cursor-pointer disabled:cursor-wait disabled:opacity-60"
                >
                  {pairingBusy ? "Getting a short code..." : "Copy short code"}
                  <span class="block text-xs text-muted-foreground">
                    Works once, for 5 minutes
                  </span>
                </button>
              </div>
            {/if}
          </div>
        </div>

        {#if shortCode}
          <div class="rounded-lg bg-muted px-3 py-2 text-center">
            <div class="select-all font-mono text-lg tracking-widest text-foreground">
              {shortCode}
            </div>
            <div class="mt-1 text-xs text-muted-foreground">
              {now >= shortCodeExpiresAt
                ? "Expired. Copy a new short code from the menu."
                : `Works once · ${shortCodeLeft} left · keep this open`}
            </div>
            <button
              type="button"
              onclick={() => { cancelPairing?.(); shortCode = null; }}
              class="mt-1 rounded-sm text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              Cancel short code
            </button>
          </div>
        {/if}
        {#if pairingBusy && !shortCode}
          <p role="status" class="text-center text-xs text-muted-foreground">Getting a short code...</p>
        {:else if pairingStatus}
          <p role="status" class="text-center text-xs text-muted-foreground">{pairingStatus}</p>
        {/if}
        {#if shortCodeError}
          <div role="alert" class="text-center text-xs text-destructive">{shortCodeError}</div>
        {/if}

        <Button
          bind:ref={joinCreatedButton}
          onclick={handleJoinCreated}
          disabled={joining}
          class="bg-primary hover:bg-primary/90 text-primary-foreground font-mono cursor-pointer w-full"
        >
          <LogIn class="size-4 mr-1" />
          {joining ? "Joining..." : "Join room"}
        </Button>
      </CardContent>
    </Card>
  {/if}
{/snippet}

{#if inDialog}
  {@render card()}
{:else}
  <!-- viewportHeight, not just a dvh class: every one of these screens centres a
       card with a text field in it, and dvh does not shrink when the software
       keyboard opens - so on a phone the field being typed into ended up under
       the keyboard. overflow-y-auto because the box is now exactly the visible
       height and a tall card has to be able to scroll inside it. The card
       centres itself with m-auto: unlike items-center, auto margins collapse
       when it is taller than the box, so its top stays reachable. -->
  <div
    use:viewportHeight
    class="flex min-h-dvh h-full overflow-y-auto p-4 bg-background"
  >
    {#if toggleSidebar != null && !createdCode}
      <Button
        onclick={toggleSidebar}
        variant="outline"
        class="absolute top-4 left-4 sm:hidden"
        aria-label="Open sidebar"
      >
        <Menu />
      </Button>
    {/if}
    {@render card()}
  </div>
{/if}

<svelte:window
  onclick={(e) => {
    if (copyMenuOpen && !(e.target as HTMLElement).closest("[data-copy-menu]"))
      copyMenuOpen = false;
  }}
  onkeydown={(e) => {
    if (e.key === "Escape") copyMenuOpen = false;
  }}
/>

<AvatarPickerDialog
  open={avatarDialogOpen}
  onClose={() => {
    avatarDialogOpen = false;
  }}
/>
