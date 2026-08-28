import { defineConfig } from "vitest/config";
import path from "path";
import { svelte } from "@sveltejs/vite-plugin-svelte";

export default defineConfig({
  // Compiled, so rune-backed stores (.svelte.ts) can be tested at all.
  plugins: [svelte()],
  resolve: {
    alias: {
      $lib: path.resolve("./src/lib"),
    },
  },
  test: {
    environment: "node",
    setupFiles: ["./src/test-setup.ts"],
    include: ["src/**/*.test.ts", "plugins/**/*.test.ts"],
  },
});
