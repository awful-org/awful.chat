<script lang="ts">
  import { requireRoomSecurityRelease } from "$lib/room-security/invitation-release";
  import GifImage from "./GifImage.svelte";
  import { mediaPrefs } from "$lib/media-prefs.svelte";
  import { newRoomCode } from "$lib/room-code";
  import { parseJoinInput } from "$lib/invite";
  import { joinInvitationPairing } from "$lib/invite-pairing";
  import { parseSecureInvitation } from "$lib/room-security/invitations";
  import { onDestroy, tick } from "svelte";
  import { Clipboard, LogIn, Menu, Plus, ScanLine } from "@lucide/svelte";
  import InviteOptions from "./InviteOptions.svelte";
  import QrScanner from "./QrScanner.svelte";
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog";
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
  // The camera opens in a dialog of its own, over this card.
  let scanning = $state(false);
  let scanHint = $state<string | null>(null);
  let scanError = $state<string | null>(null);
  const qrSize = $derived(inDialog ? "size-50" : "size-60");
  let joinController: AbortController | undefined;
  let alive = true;
  onDestroy(() => { alive = false; joinController?.abort(); });
  const createdSecret = $derived(createdCode ? parseSecureInvitation(createdCode) : null);
  // Joining the room just created can fail; the invite itself is
  // InviteOptions', and its short code outlives this card.
  let createdError = $state<string | null>(null);
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
      scanning = false;
      createdError = null;
      // The focused Create button is gone; joining is the next step.
      void tick().then(() => joinCreatedButton?.focus());
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
      createdCode = null;
    } catch (err) {
      createdError = err instanceof Error ? err.message : "Could not open the room";
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

  // A room's QR carries its invite link (or a short link); any other QR is
  // not ours and the camera keeps looking.
  function handleScannedText(text: string): boolean {
    if (parseJoinInput(text).kind === "invalid") {
      scanHint = "That QR code isn't a room invite.";
      return false;
    }
    scanning = false;
    scanHint = null;
    joinCode = text.trim();
    // After the field's effect: it aborts the join in flight whenever the
    // text changes, which would be this one if it started first.
    void tick().then(handleJoin);
    return true;
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
              placeholder="Link or short code"
              class="bg-background border-input text-foreground placeholder:text-muted-foreground font-mono pr-16 focus-visible:ring-ring"
            />
            <div class="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-2">
              <button
                type="button"
                onclick={() => { scanHint = null; scanError = null; scanning = true; }}
                class="text-muted-foreground hover:text-foreground cursor-pointer"
                aria-label="Scan a QR code"
                title="Scan a QR code"
              >
                <ScanLine class="size-4" />
              </button>
              <button
                type="button"
                onclick={handlePaste}
                class="text-muted-foreground hover:text-foreground cursor-pointer"
                aria-label="Paste room code"
              >
                <Clipboard class="size-4" />
              </button>
            </div>
          </div>
          <!-- Content only while open, so the camera stops when it closes. -->
          <Dialog bind:open={scanning}>
            <DialogContent
              class="bg-card border-border text-card-foreground font-mono w-full sm:max-w-sm flex flex-col gap-0 p-0 max-h-[calc(100dvh-2rem)] overflow-hidden"
            >
              <DialogHeader class="px-6 py-4 border-b border-border shrink-0">
                <DialogTitle class="font-mono text-base font-semibold">Scan a QR code</DialogTitle>
                <DialogDescription class="text-xs">
                  Point the camera at a room's QR code.
                </DialogDescription>
              </DialogHeader>
              <div class="flex min-h-0 flex-col gap-3 overflow-y-auto p-4">
                {#if scanError}
                  <p role="alert" class="rounded-lg bg-destructive/10 border border-destructive/30 px-3 py-2 text-sm text-destructive">
                    {scanError}
                  </p>
                {:else}
                  <QrScanner
                    onText={handleScannedText}
                    onUnavailable={(message) => {
                      scanError = /https/i.test(message)
                        ? message
                        : "Couldn't open the camera. Allow camera access in your browser, or paste the link instead.";
                    }}
                  />
                  {#if scanHint}
                    <p role="alert" class="text-center text-xs text-destructive">{scanHint}</p>
                  {/if}
                {/if}
              </div>
            </DialogContent>
          </Dialog>
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
          Invite people with a short code, or share the permanent link.
        </CardDescription>
      </CardHeader>
      <!-- grid-cols-1 (minmax(0, 1fr)) so the long link cannot widen the card. -->
      <CardContent class="grid grid-cols-1 gap-4">
        <InviteOptions secret={createdSecret} link={createdLink} {qrSize} />
        {#if createdError}
          <div role="alert" class="text-center text-xs text-destructive">{createdError}</div>
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

<AvatarPickerDialog
  open={avatarDialogOpen}
  onClose={() => {
    avatarDialogOpen = false;
  }}
/>
