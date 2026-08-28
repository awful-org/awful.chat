import tailwindcss from "@tailwindcss/vite";
import { execSync } from "node:child_process";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "path";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { VitePWA } from "vite-plugin-pwa";
import pkg from "./package.json";

export default defineConfig(({ mode }) => ({
  // Read VITE_* vars from the repo-root .env so bare `pnpm dev` works
  // outside docker. Only VITE_-prefixed vars are exposed to the client;
  // in docker builds the values arrive via ARG/ENV instead.
  envDir: "..",
  define: {
    global: "globalThis",
    // The app's version, straight from package.json at build time.
    __APP_VERSION__: JSON.stringify(pkg.version),
    // Best-effort commit hash: pre-1.0 every deploy shares the version, so
    // the hash is what actually identifies a build. Empty when the build
    // context has no git (some docker contexts) - the UI just omits it.
    __APP_COMMIT__: JSON.stringify(
      (() => {
        try {
          return execSync("git rev-parse --short HEAD", {
            stdio: ["ignore", "pipe", "ignore"],
          })
            .toString()
            .trim();
        } catch {
          return "";
        }
      })()
    ),
  },
  plugins: [
    tailwindcss(),
    svelte(),
    nodePolyfills(),
    VitePWA({
      registerType: "prompt",
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectManifest: {
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // Keep the install payload small. These are cached at runtime by sw.ts
        // the first time they are used instead of being downloaded up front on
        // every install and every update.
        globIgnores: [
          "**/node_modules/**/*",
          "assets/langs/**", // ~300 shiki language chunks, ~8 MB
          "assets/lazy/**", // shiki themes+wasm engine, webtorrent: ~2.6 MB
          "audio-worklet.js", // DTLN wasm, ~8 MB
          "third-party-notices.txt", // ~500 KB of license texts, on demand
        ],
      },
      includeAssets: ["favicon.ico", "apple-touch-icon-180x180.png"],
      manifest: {
        name: "Awful.chat",
        short_name: "Awful.chat",
        description:
          "End-to-end encrypted P2P chat with voice, video, and file sharing. Open source. No accounts, no phone numbers, no personal data required.",
        // NEVER change this id. Browsers key installed PWAs by it: the one
        // historical change ("awfulchat" -> "/") is why some devices carry
        // two Awful.chat icons - each id is a separate app to the OS, and
        // no code can merge or remove an already-installed one.
        id: "/",
        scope: "/",
        start_url: "/app",
        display: "standalone",
        background_color: "#09090b",
        // Matches the <meta name="theme-color"> in index.html - a green chrome
        // around a near-black app looked like a rendering bug.
        theme_color: "#09090b",
        lang: "en",
        icons: [
          {
            src: "pwa-64x64.png",
            sizes: "64x64",
            type: "image/png",
          },
          {
            src: "pwa-192x192.png",
            sizes: "192x192",
            type: "image/png",
          },
          {
            src: "pwa-512x512.png",
            sizes: "512x512",
            type: "image/png",
          },
          {
            src: "maskable-icon-512x512.png",
            sizes: "512x512",
            type: "image/png",
            purpose: "maskable",
          },
        ],
        dir: "ltr",
        // No orientation lock: video calls and screen share are usable in
        // landscape, and locking to portrait fought the user on tablets.
        display_override: ["standalone", "minimal-ui"],
        categories: ["entertainment", "social"],
        // Android shows the richer install dialog only when both form factors
        // are present.
        screenshots: [
          {
            src: "screenshot-wide.png",
            sizes: "1280x800",
            type: "image/png",
            form_factor: "wide",
            label: "A room in Awful.chat on desktop",
          },
          {
            src: "screenshot-narrow.png",
            sizes: "412x892",
            type: "image/png",
            form_factor: "narrow",
            label: "A room in Awful.chat on mobile",
          },
        ],
        // Share targets and web+awfl links should surface the running app
        // instead of opening a second copy of it.
        launch_handler: { client_mode: ["navigate-existing", "auto"] },
        // Double-clicking a backup file opens the app straight into the
        // restore flow (consumed via launchQueue in AppView).
        file_handlers: [
          {
            action: "/app",
            accept: { "application/awful-backup": [".awfulbackup"] },
          },
        ],
        shortcuts: [
          {
            name: "New room",
            short_name: "New room",
            description: "Create or join a room",
            url: "/app?new=1",
            icons: [{ src: "pwa-192x192.png", sizes: "192x192" }],
          },
          {
            name: "Pair a device",
            short_name: "Pair",
            description: "Sync this account to another device",
            url: "/app?sync=1",
            icons: [{ src: "pwa-192x192.png", sizes: "192x192" }],
          },
        ],
        share_target: {
          action: "/share-target",
          method: "POST",
          enctype: "multipart/form-data",
          params: {
            title: "title",
            text: "text",
            url: "url",
            files: [
              {
                name: "files",
                accept: [
                  "image/*",
                  "video/*",
                  "audio/*",
                  "text/plain",
                  "application/pdf",
                ],
              },
            ],
          },
        } as const,
        handle_links: "preferred",
        protocol_handlers: [
          {
            protocol: "web+awfl",
            url: "/r/%s",
          },
        ],
      },
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        entryFileNames: "assets/[name]-[hash].js",
        // Shiki ships one chunk per language. Park them in their own directory
        // so the service worker can leave them out of the precache and fetch
        // them on demand (see globIgnores above).
        chunkFileNames: (chunk) => {
          const id = chunk.facadeModuleId ?? "";
          if (/[\\/](@shikijs[\\/]langs|shiki[\\/]dist[\\/]langs)[\\/]/.test(id))
            return "assets/langs/[name]-[hash].js";
          // Same trick for the other on-demand heavyweights: 70 shiki theme
          // chunks (only github-dark is ever loaded), the oniguruma wasm
          // engine, and webtorrent. Together they were 46% of the precache,
          // re-downloaded on every deploy by sessions that never used them.
          if (
            /[\\/](@shikijs[\\/]themes|shiki[\\/]dist[\\/]themes)[\\/]|[\\/]@shikijs[\\/]engine-oniguruma[\\/]|[\\/]shiki[\\/]dist[\\/]wasm|[\\/]webtorrent[\\/]/.test(
              id
            )
          )
            return "assets/lazy/[name]-[hash].js";
          return "assets/[name]-[hash].js";
        },
        assetFileNames: "assets/[name]-[hash].[ext]",
      },
    },
  },
  resolve: {
    alias: {
      $lib: path.resolve("./src/lib"),
      webtorrent: "webtorrent/webtorrent.min.js",
    },
  },
  server:
    mode === "development"
      ? {
          proxy: {
            "/klipy": "http://relay:8081",
            "/og": "http://relay:8081",
          },
        }
      : {},
}));
