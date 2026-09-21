<script lang="ts">
  import { onMount } from "svelte";
  import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription } from "$lib/components/ui/dialog";
  import { _voice } from "$lib/transport/transport.svelte";
  import { voiceDiagnosticsView, type VoiceDiagnostics } from "$lib/voice-diagnostics";

  let { peerId, name, onClose }: { peerId: string; name: string; onClose: () => void } = $props();
  let sample = $state<VoiceDiagnostics | null>(null);
  let now = $state(performance.now());
  const view = $derived(voiceDiagnosticsView(sample, now));
  onMount(() => {
    const refresh = () => {
      now = performance.now();
      sample = _voice?.getPeerDiagnostics(peerId) ?? null;
    };
    refresh();
    const timer = setInterval(refresh, 1000);
    return () => clearInterval(timer);
  });
</script>

<Dialog open={true} onOpenChange={(open) => { if (!open) onClose(); }}>
  <DialogContent class="font-mono sm:max-w-sm">
    <DialogHeader>
      <DialogTitle>Connection details</DialogTitle>
      <DialogDescription>{name} · Voice connection</DialogDescription>
    </DialogHeader>
    <dl class="grid grid-cols-[1fr_auto] gap-x-4 gap-y-3 text-xs">
      <dt class="text-muted-foreground">Route</dt><dd>{view.route}</dd>
      <dt class="text-muted-foreground">Round-trip latency</dt><dd>{view.latency}</dd>
      <dt class="text-muted-foreground">Audio</dt><dd>{view.audio}</dd>
      <dt class="text-muted-foreground">Connection</dt><dd>{sample?.connectionState ?? "Not connected"}</dd>
      <dt class="text-muted-foreground">ICE state</dt><dd>{sample?.iceState ?? "Unavailable"}</dd>
      <dt class="text-muted-foreground">Last stats sample</dt>
      <dd>{view.ageSeconds === null ? "Not received" : `${view.ageSeconds} seconds ago`}</dd>
    </dl>
    {#if view.stale}
      <p role="status" class="text-xs text-amber-500">Status may be outdated. Waiting for fresh measurements.</p>
    {:else if !sample}
      <p role="status" class="text-xs text-muted-foreground">Waiting for a voice connection and browser measurements.</p>
    {/if}
    <p class="text-xs text-muted-foreground">TURN can be a healthy connection. Audio data includes silence; it does not mean this person is speaking. These measurements describe voice, not camera or screen sharing.</p>
  </DialogContent>
</Dialog>
