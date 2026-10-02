<script lang="ts">
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog";
  import { CircleAlert, RefreshCw } from "@lucide/svelte";
  import InviteOptions from "./InviteOptions.svelte";
  import { savedRoomInvitationLink, parseSecureInvitation } from "$lib/room-security/invitations";
  import type { RoomSecret } from "$lib/room-security/keys";
  let { roomCode, open = $bindable(false) }: { roomCode: string; open?: boolean } = $props();
  let link = $state("");
  let unavailable = $state<string | null>(null);
  const secret = $derived(link ? parseSecureInvitation(link) as RoomSecret : null);
  $effect(() => {
    const room = roomCode;
    if (!open) return;
    let current = true;
    link = "";
    unavailable = null;
    void savedRoomInvitationLink(window.location.origin, room)
      .then((value) => { if (current) link = value; })
      .catch((err) => {
        if (current) unavailable = err instanceof Error ? err.message : "This room's invite link is not available.";
      });
    return () => { current = false; link = ""; };
  });
</script>

<Dialog bind:open>
  <DialogContent
    class="bg-card border-border text-card-foreground font-mono w-full sm:max-w-sm flex flex-col gap-0 p-0 max-h-[calc(100dvh-2rem)] overflow-hidden"
  >
    <DialogHeader class="px-6 py-4 border-b border-border shrink-0">
      <DialogTitle class="font-mono text-base font-semibold">Invite to this room</DialogTitle>
      <DialogDescription class="text-xs">
        Share a short code, or the permanent link below it.
      </DialogDescription>
    </DialogHeader>

    <div class="flex min-h-0 flex-col gap-4 overflow-y-auto p-4">
      {#if unavailable}
        <div class="flex flex-col items-center gap-2 py-6 text-center">
          <CircleAlert class="size-8 text-destructive" />
          <p role="alert" class="text-xs text-destructive">{unavailable}</p>
        </div>
      {:else if !link}
        <div class="flex justify-center py-10" aria-label="Loading">
          <RefreshCw class="size-8 animate-spin text-muted-foreground" />
        </div>
      {:else}
        <InviteOptions {secret} {link} />
      {/if}
    </div>
  </DialogContent>
</Dialog>
