<script lang="ts">
  import type { PluginComponent } from "$lib/plugins/api";
  import { getPlugin } from "$lib/plugins/registry";
  import { getCardState, onCardStateChange } from "$lib/plugins/state.svelte";
  import { makeHostApi } from "$lib/plugins/host";
  import { setSelfActivity } from "$lib/plugins/activity.svelte";
  import { onDestroy } from "svelte";
  import { getMessage } from "$lib/storage";
  import type { Message } from "$lib/transport/transport.svelte";

  let {
    pluginId,
    cardId,
    roomCode,
    chromeVisible = true,
    focused = false,
    setFocused = () => {},
  }: {
    pluginId: string;
    cardId: string;
    roomCode: string;
    /** Mirrors the call's controls visibility (mouse moving over the call
     *  section) so plugin controls appear and hide WITH the call chrome. */
    chromeVisible?: boolean;
    /** The tile is focused, and the way to change that - for the plugin's
     *  own button, since its content may swallow the tile's clicks. */
    focused?: boolean;
    setFocused?: (focused: boolean) => void;
  } = $props();

  let card = $state<Message | null>(null);
  let tileComponent = $state<PluginComponent | null>(null);
  let tileState = $state<unknown>(undefined);

  // One host per (plugin, room): a fresh host per render meant a fresh
  // now-playing token per card-state tick, churning the OS media surface.
  const hostApi = $derived(makeHostApi(pluginId, roomCode));

  // Whatever the tile said you were doing ends with the tile.
  onDestroy(() => setSelfActivity(pluginId, null));

  // Same tick bridge as MsgRender/PluginWidgetBox: repaint when updates fold.
  let tick = $state(0);
  $effect(() => onCardStateChange(() => (tick += 1)));

  $effect(() => {
    void tick;
    void (async () => {
      try {
        const plugin = await getPlugin(pluginId);
        if (!plugin?.callTile) return;
        card = card ?? (await getMessage(cardId)) ?? null;
        if (!card) return;
        tileState = await getCardState(cardId, roomCode, plugin);
        tileComponent = plugin.callTile;
      } catch (err) {
        console.warn("[plugins] call tile load failed:", err);
      }
    })();
  });
</script>

{#if tileComponent && card}
  {@const TileUi = tileComponent}
  <TileUi
    {card}
    cardState={tileState}
    host={hostApi}
    {chromeVisible}
    {focused}
    {setFocused}
  />
{:else}
  <div
    class="grid h-full w-full place-items-center font-mono text-xs text-muted-foreground"
  >
    Loading...
  </div>
{/if}
