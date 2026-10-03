import { Puzzle } from "@lucide/svelte";
import { getPlugin, getRegistry } from "$lib/plugins/registry";
import { isPluginEnabled } from "$lib/plugins/prefs.svelte";
import { makeHostApi } from "$lib/plugins/host";
import { showPluginError } from "$lib/plugins/plugin-errors.svelte";
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
            const room = host.activeRoomCode ?? "";
            try {
              await handler(makeHostApi(pluginId, room));
            } catch (err) {
              // The palette has closed by now: the same note a thrown slash
              // command gets, so the failure is not silent.
              showPluginError(
                pluginId,
                room,
                err instanceof Error && err.message ? err.message : `${entry.title} did not work.`,
              );
              throw err;
            }
          },
        },
      });
    }
  }
  return cmds;
};
