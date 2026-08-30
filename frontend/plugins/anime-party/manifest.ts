import type { PluginManifest } from "$lib/plugins/api";

export const manifest: PluginManifest = {
  id: "anime-party",
  name: "Anime Party",
  description:
    "Watch an episode together. Everyone opens their own file; the party keeps every player in step.",
  icon: "lucide:clapperboard",
  author: "awful.chat",
  license: "Apache-2.0",
  version: "1.0.0",
  repository: "https://github.com/awful-org/awful.chat/tree/main/frontend/plugins/anime-party",
  apiVersion: 1,
  commands: [{ name: "anime-party", usage: "/anime-party One Piece" }],
};
