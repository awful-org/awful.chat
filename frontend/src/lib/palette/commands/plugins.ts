import { Puzzle } from "@lucide/svelte";
import { getPlugin, getRegistry } from "$lib/plugins/registry";
import { isPluginEnabled } from "$lib/plugins/prefs.svelte";
import { makeHostApi } from "$lib/plugins/host";
import type { Cmd } from "../types";
import type { CmdSource } from "../host";

/**
 * Actions plugins add to the palette.
 *
 * Listed from `manifest.paletteCommands`, which is eager-loaded, so the
 * catalog never has to load plugin code just to draw a row - the same
 * reasoning as `manifest.commands` for the composer's "/" popup (see
 * ChatView.svelte's `filteredCommands`). The handler itself lives on the
 * lazy-loaded `PluginDefinition.paletteCommands` and is fetched only once
 * the user actually accepts the row.
 */
export const pluginCommands: CmdSource = (host) => {
  const cmds: Cmd[] = [];
  for (const [pluginId, registered] of getRegistry()) {
    if (!isPluginEnabled(pluginId)) continue;
    for (const entry of registered.manifest.paletteCommands ?? []) {
      cmds.push({
        id: `plugin.command:${pluginId}:${entry.name}`,
        title: entry.title,
        subtitle: entry.subtitle ?? registered.manifest.name,
        keywords: [registered.manifest.name],
        group: "Plugins",
        icon: Puzzle,
        action: {
          kind: "act",
          perform: async () => {
            const plugin = await getPlugin(pluginId);
            const handler = plugin?.paletteCommands?.[entry.name];
            if (!handler) {
              console.warn(
                `[palette] plugin "${pluginId}" has no paletteCommands["${entry.name}"]`
              );
              return;
            }
            // "" with no room open, same binding the settings surface gets.
            await handler(makeHostApi(pluginId, host.activeRoomCode ?? ""));
          },
        },
      });
    }
  }
  return cmds;
};
