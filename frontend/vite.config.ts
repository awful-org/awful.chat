import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "path";
import { nodePolyfills } from "vite-plugin-node-polyfills";

// https://vite.dev/config/
export default defineConfig({
  plugins: [tailwindcss(), svelte(), nodePolyfills()],
  resolve: {
    alias: {
      $lib: path.resolve("./src/lib"),
      webtorrent: "webtorrent/webtorrent.min.js",
    },
  },
});
