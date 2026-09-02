import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";
import path from "node:path";

// The operator console. It is NOT deployed: it runs on a developer's own
// machine and talks to a relay with an admin token. A console on the public
// internet is not worth the risk, so there is no Dockerfile and no nginx
// config here.
export default defineConfig({
  plugins: [svelte(), tailwindcss()],
  resolve: {
    alias: { $lib: path.resolve(import.meta.dirname, "./src/lib") },
  },
  server: { port: 5174 },
});
