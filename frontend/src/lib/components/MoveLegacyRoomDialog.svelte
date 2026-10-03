<script lang="ts">
  /**
   * Offered when someone opens an old (legacy) room: move it to a secure
   * room instead of leaving it a dead end. See room-security/legacy-move.ts
   * for what moving does and why the history stays on each device.
   *
   * It asks the person to check their DMs first - someone from the room may
   * have moved it already and sent them the invitation - and so it must be
   * easy to come back to: closing it is "not now", and the archive keeps a
   * button that reopens it.
   */
  import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogHeader,
    DialogTitle,
  } from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { Label } from "$lib/components/ui/label";
  import { Switch } from "$lib/components/ui/switch";
  import { MessageSquare } from "@lucide/svelte";

  interface Props {
    open: boolean;
    roomName: string;
    /** Other members of the old room this device knows of. */
    memberCount: number;
    busy?: boolean;
    error?: string | null;
    onMove: (inviteOthers: boolean) => void;
    onCheckDms: () => void;
    onClose: () => void;
  }

  let {
    open = $bindable(false),
    roomName,
    memberCount,
    busy = false,
    error = null,
    onMove,
    onCheckDms,
    onClose,
  }: Props = $props();

  // On by default: it is what spares everybody else the same popup.
  let inviteOthers = $state(true);
</script>

<Dialog bind:open onOpenChange={(o) => { if (!o) onClose(); }}>
  <DialogContent
    class="bg-card border-border text-card-foreground font-mono w-[calc(100%-2rem)] sm:max-w-md max-h-[calc(100dvh-2rem)] overflow-y-auto flex flex-col p-0"
  >
    <DialogHeader class="px-6 py-4 border-b border-border shrink-0">
      <DialogTitle class="font-mono text-base font-semibold">
        Move "{roomName}" to a secure room
      </DialogTitle>
      <DialogDescription class="text-xs font-mono text-muted-foreground leading-relaxed">
        Sorry about this. awful.chat moved to end-to-end encrypted rooms, and
        old rooms like this one can't send messages anymore.
      </DialogDescription>
    </DialogHeader>

    <div class="flex flex-col gap-4 px-4 pb-2">
      <div class="flex flex-col gap-3 p-4 bg-muted/30 rounded-lg border border-border/50">
        <p class="text-xs font-mono text-muted-foreground leading-relaxed">
          <span class="text-foreground">Check your DMs first.</span> Someone
          from this room may have moved it already and sent you an invitation
          - joining theirs keeps everyone in one room. This window will be
          here when you come back.
        </p>
        <Button
          variant="outline"
          class="font-mono self-start"
          onclick={onCheckDms}
        >
          <MessageSquare class="size-4 mr-1" />
          Check DMs
        </Button>
      </div>

      <p class="text-xs font-mono text-muted-foreground leading-relaxed px-1">
        Moving creates a secure room with the same name, picture and place in
        your sidebar. The messages from this room come along on this device.
      </p>

      {#if memberCount > 0}
        <label class="flex items-center justify-between gap-3 px-1 cursor-pointer">
          <span class="flex flex-col gap-0.5">
            <Label class="text-xs font-mono text-foreground cursor-pointer">
              Invite the other {memberCount === 1 ? "member" : `${memberCount} members`}
            </Label>
            <span class="text-xs font-mono text-muted-foreground leading-relaxed">
              Each gets a DM saying what happened, with the invitation.
            </span>
          </span>
          <Switch aria-label="Invite the other members by DM" bind:checked={inviteOthers} />
        </label>
      {/if}

      {#if error}
        <p role="alert" class="text-xs font-mono text-destructive px-1">{error}</p>
      {/if}
    </div>

    <DialogFooter class="px-6 pb-5 pt-3 border-t border-border shrink-0 flex gap-2">
      <Button variant="ghost" class="font-mono" disabled={busy} onclick={onClose}>
        Not now
      </Button>
      <Button
        class="bg-primary hover:bg-primary/90 text-primary-foreground font-mono"
        disabled={busy}
        onclick={() => onMove(memberCount > 0 && inviteOthers)}
      >
        {busy ? "Moving..." : "Move room"}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
