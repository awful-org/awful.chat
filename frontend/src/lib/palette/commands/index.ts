import type { Cmd } from "../types";
import type { CmdSource, PaletteHost } from "../host";
import { roomCommands } from "./rooms";
import { settingsCommands } from "./settings";
import { actionCommands } from "./actions";

export const allSources: CmdSource[] = [
  roomCommands,
  settingsCommands,
  actionCommands,
];

/** Concatenate every command source into the full catalog for one host. */
export function buildCatalog(host: PaletteHost): Cmd[] {
  return allSources.flatMap((source) => source(host));
}
