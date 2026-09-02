import { defineConfig } from "vitest/config";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "node:path";

export default defineConfig({
  // Compiled, so a rune-backed store (.svelte.ts) can be tested at all.
  plugins: [svelte()],
  resolve: {
    alias: { $lib: path.resolve(import.meta.dirname, "./src/lib") },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
});
