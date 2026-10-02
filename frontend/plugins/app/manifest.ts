import type { PluginManifest } from "$lib/plugins/api";

export const manifest: PluginManifest = {
  id: "app",
  name: "Apps",
  description: "Open any website as a tile in the call - a game, a board, a shared page.",
  icon: "lucide:app-window",
  author: "awful.chat",
  license: "Apache-2.0",
  version: "1.0.0",
  repository: "https://github.com/awful-org/awful.chat/tree/main/frontend/plugins/app",
  apiVersion: 1,
  commands: [{ name: "app", usage: "/app https://example.com [anything for the app]" }],
  requires: ["self-name"],
};
