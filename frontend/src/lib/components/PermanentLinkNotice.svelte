<script lang="ts">
  /**
   * Under a room's full invite link, wherever one is shown. The link is the
   * room's capability itself: nothing can expire it or count who uses it.
   * A short code is the invite with limits (ShortCodeLimits).
   */
  import { TriangleAlert } from "@lucide/svelte";
</script>

<p class="flex items-start gap-2 rounded-md border border-amber-500/40 bg-amber-500/5 px-3 py-2 text-[11px] leading-relaxed text-muted-foreground">
  <TriangleAlert class="mt-0.5 size-3.5 shrink-0 text-amber-500" />
  <span>
    This link never expires and has no limit: anyone who gets it can join, now or later,
    including people it is forwarded to. To choose how many people and for how long, use a
    short code.
  </span>
</p>
