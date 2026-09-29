<script lang="ts">
  import { Dialog, DialogContent, DialogHeader, DialogTitle } from "$lib/components/ui/dialog";
  import { Button } from "$lib/components/ui/button";
  import { savedRoomInvitationLink, parseSecureInvitation } from "$lib/room-security/invitations";
  import { hostInvitationPairing } from "$lib/invite-pairing";
  import { requireRoomSecurityRelease } from "$lib/room-security/invitation-release";
  import QRCode from "qrcode";
  let { roomCode, open = $bindable(false) }: { roomCode: string; open?: boolean } = $props();
  let link = $state("");
  let qr = $state("");
  let code = $state("");
  let status = $state("");
  let busy = $state(false);
  let cancel: (() => void) | undefined;
  let controller: AbortController | undefined;
  let generation = 0;
  $effect(() => {
    const room = roomCode;
    if (!open) return;
    const current = ++generation;
    link = qr = code = status = "";
    void savedRoomInvitationLink(window.location.origin, room).then(async value => {
      const image = await QRCode.toDataURL(value, { width: 280, margin: 2 });
      if (current === generation) { link = value; qr = image; }
    }).catch(() => { if (current === generation) status = "Invitation unavailable"; });
    return () => { generation++; controller?.abort(); cancel?.(); cancel = undefined; link = qr = code = ""; busy = false; };
  });
  async function pairing() {
    if (busy || !link) return;
    const current = generation;
    busy = true;
    controller?.abort(); cancel?.(); code = "";
    controller = new AbortController();
    try {
      requireRoomSecurityRelease();
      const pair = await hostInvitationPairing(parseSecureInvitation(link), value => { if (current === generation) { status = value; code = ""; } }, controller.signal);
      if (current !== generation) { pair.cancel(); return; }
      cancel = pair.cancel; code = pair.code;
      status = "Keep this dialog open. Single use; expires in 5 minutes; at most 5 attempts.";
    } catch { if (current === generation) status = "Pairing unavailable. Try the full invitation link."; }
    finally { if (current === generation) busy = false; }
  }
  async function copy(value: string) {
    const current = generation;
    try { await navigator.clipboard.writeText(value); if (current === generation) status = "Copied"; }
    catch { if (current === generation) status = "Clipboard unavailable. Select and copy the invitation."; }
  }
  async function share() {
    const current = generation;
    try { await navigator.share({ url: link }); }
    catch (err) { if (current === generation && (err as Error).name !== "AbortError") status = "Sharing unavailable. Copy the invitation link."; }
  }
</script>

<Dialog bind:open>
  <DialogContent class="max-w-sm">
    <DialogHeader><DialogTitle>Invite to this room</DialogTitle></DialogHeader>
    <p class="text-sm text-muted-foreground">Anyone with this link can join. The QR contains the same complete invitation.</p>
    {#if qr}<img src={qr} alt="Room invitation QR code" class="mx-auto" />{/if}
    {#if link}<input aria-label="Invitation link" readonly value={link} class="w-full font-mono text-xs" />{/if}
    <Button disabled={!link} onclick={() => copy(link)}>Copy invitation link</Button>
    {#if typeof navigator.share === "function"}<Button disabled={!link} variant="outline" onclick={share}>Share invitation</Button>{/if}
    <Button disabled={busy || !link} variant="outline" onclick={pairing}>{busy ? "Preparing…" : "Generate online pairing code"}</Button>
    {#if code}
      <p class="select-all text-center font-mono text-lg">{code}</p>
      <Button variant="outline" onclick={() => copy(code)}>Copy pairing code</Button>
      <Button variant="ghost" onclick={() => { cancel?.(); code = ""; status = "Pairing cancelled"; }}>Cancel pairing</Button>
    {/if}
    <p role="status" class="text-sm text-muted-foreground">{status}</p>
  </DialogContent>
</Dialog>
