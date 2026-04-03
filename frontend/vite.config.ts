import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import path from "path";
import { nodePolyfills } from "vite-plugin-node-polyfills";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig(({ mode }) => ({
  define: {
    global: "globalThis",
  },
  plugins: [
    tailwindcss(),
    svelte(),
    nodePolyfills(),
    VitePWA({
      registerType: "autoUpdate",
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      injectManifest: {
        maximumFileSizeToCacheInBytes: 23 * 1024 * 1024,
      },
      includeAssets: ["favicon.ico", "apple-touch-icon-180x180.png"],
      manifest: {
        name: "Awful.chat",
        short_name: "Awful.chat",
        description:
          "End-to-end encrypted P2P chat with voice, video, and file sharing. Open source. No accounts, no phone numbers, no personal data required.",
        id: "/",
        scope: "/",
        start_url: "/app",
        display: "standalone",
        background_color: "#09090b",
        theme_color: "#00ff88",
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
        orientation: "portrait",
        categories: ["entertainment", "social"],
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
        chunkFileNames: "assets/[name]-[hash].js",
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
