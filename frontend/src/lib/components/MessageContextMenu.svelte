<script lang="ts">
  import { tick, type Component } from "svelte";
  import { messageMenuPosition } from "$lib/message-context-menu";

  interface Props {
    x: number;
    y: number;
    actions: { label: string; icon: Component<{ class?: string }>; run: (trigger: HTMLElement) => void }[];
    onClose: (restoreFocus?: boolean) => void;
  }
  let { x, y, actions, onClose }: Props = $props();
  let panel = $state<HTMLDivElement>();
  let width = $state(208);
  let height = $state(112);
  let viewportWidth = $state(0);
  let viewportHeight = $state(0);
  const position = $derived(messageMenuPosition(x, y, width, height, viewportWidth, viewportHeight));

  $effect(() => {
    // Reopening on another message also resets keyboard focus to the first item.
    void actions;
    void tick().then(() => panel?.querySelector<HTMLButtonElement>("button")?.focus({ preventScroll: true }));
  });

  $effect(() => {
    function outside(e: PointerEvent) {
      if (!panel?.contains(e.target as Node)) onClose(false);
    }
    function scroll(e: Event) {
      if (!panel?.contains(e.target as Node)) onClose(false);
    }
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("scroll", scroll, true);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      document.removeEventListener("scroll", scroll, true);
    };
  });

  function keydown(e: KeyboardEvent) {
    e.stopPropagation();
    const items = [...(panel?.querySelectorAll<HTMLButtonElement>("button") ?? [])];
    const current = items.indexOf(document.activeElement as HTMLButtonElement);
    if (e.key === "Escape" || e.key === "Tab") {
      if (e.key === "Escape") e.preventDefault();
      onClose(true);
    } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(e.key)) {
      e.preventDefault();
      const index = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 :
        (current + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
      items[index]?.focus();
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey && e.key !== " ") {
      const ordered = [...items.slice(current + 1), ...items.slice(0, current + 1)];
      ordered.find((item) => item.textContent?.trim().toLowerCase().startsWith(e.key.toLowerCase()))?.focus();
    }
  }
</script>

<svelte:window bind:innerWidth={viewportWidth} bind:innerHeight={viewportHeight} onresize={() => onClose(false)} onblur={() => onClose(false)} />

<div
  bind:this={panel}
  bind:offsetWidth={width}
  bind:offsetHeight={height}
  role="menu"
  aria-label="Message actions"
  tabindex="-1"
  onkeydown={keydown}
  oncontextmenu={(e) => e.preventDefault()}
  class="fixed z-50 w-52 max-w-[calc(100vw-16px)] max-h-[calc(100dvh-16px)] overflow-y-auto rounded-md border border-border bg-card p-1 text-foreground shadow-xl"
  style={`left:${position.left}px;top:${position.top}px;`}
>
  {#each actions as action (action.label)}
    <button
      type="button"
      role="menuitem"
      tabindex="-1"
      class="flex w-full cursor-pointer items-center gap-2 rounded-sm px-2 py-2 text-left text-xs outline-none hover:bg-muted focus:bg-muted"
      onclick={(e) => {
        // React needs this item's rect before closing unmounts it.
        action.run(e.currentTarget);
        onClose(false);
      }}
    >
      <action.icon class="size-3.5 text-muted-foreground" />
      {action.label}
    </button>
  {/each}
</div>
