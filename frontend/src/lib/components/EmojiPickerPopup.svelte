<script lang="ts">
  import "emoji-picker-element";

  interface Props {
    open: boolean;
    x: number;
    y: number;
    onSelect: (emoji: string) => void;
    onClose: () => void;
  }

  let { open, x, y, onSelect, onClose }: Props = $props();

  const left = $derived(
    typeof window === "undefined"
      ? x
      : Math.max(8, Math.min(x, window.innerWidth - 360))
  );
  const top = $derived(
    typeof window === "undefined"
      ? y
      : Math.max(8, Math.min(y, window.innerHeight - 460))
  );
</script>

{#if open}
  <button
    type="button"
    class="fixed inset-0 z-[90] cursor-default"
    aria-label="Close emoji picker"
    onclick={onClose}
  ></button>

  <div
    class="fixed z-[100] w-[340px] overflow-hidden rounded-xl border border-border bg-card shadow-2xl"
    style={`left:${left}px; top:${top}px;`}
  >
    <emoji-picker
      style="height:420px;"
      onemoji-click={(e: any) => {
        onSelect(e.detail.unicode);
        onClose();
      }}
    ></emoji-picker>
  </div>
{/if}
