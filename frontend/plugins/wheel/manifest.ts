import type { PluginManifest } from "$lib/plugins/api";

export const manifest: PluginManifest = {
  id: "wheel",
  name: "Wheel decide",
  description: "Spin a wheel to settle what to play.",
  icon: "lucide:ferris-wheel",
  author: "awful.chat",
  license: "Apache-2.0",
  version: "1.1.0",
  repository: "https://github.com/awful-org/awful.chat/tree/main/frontend/plugins/wheel",
  apiVersion: 1,
  commands: [{ name: "wheel", usage: "/wheel Question? option1, option2, ..." }],
};
