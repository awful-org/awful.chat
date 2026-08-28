<script lang="ts">
  // Every project this app is built on. Kept here (not generated from
  // package.json) so each entry can say what it actually does for us.
  const groups: {
    label: string;
    items: { name: string; what: string; url: string }[];
  }[] = [
    {
      label: "Networking",
      items: [
        {
          name: "js-libp2p",
          what: "peer discovery, encrypted streams, pubsub rooms",
          url: "https://github.com/libp2p/js-libp2p",
        },
        {
          name: "go-libp2p",
          what: "the relay that helps peers find each other",
          url: "https://github.com/libp2p/go-libp2p",
        },
        {
          name: "gossipsub",
          what: "how room messages spread between peers",
          url: "https://github.com/ChainSafe/js-libp2p-gossipsub",
        },
        {
          name: "noise + yamux",
          what: "connection encryption and stream multiplexing",
          url: "https://github.com/ChainSafe/js-libp2p-noise",
        },
        {
          name: "WebTorrent",
          what: "peer-to-peer file transfer",
          url: "https://webtorrent.io",
        },
        {
          name: "simple-peer",
          what: "the WebRTC handshake voice calls ride on",
          url: "https://github.com/feross/simple-peer",
        },
        {
          name: "mediasoup",
          what: "the SFU that routes video and screen share",
          url: "https://mediasoup.org",
        },
        {
          name: "coturn",
          what: "TURN relay for calls behind strict NATs",
          url: "https://github.com/coturn/coturn",
        },
        {
          name: "ws",
          what: "the SFU's websocket signalling",
          url: "https://github.com/websockets/ws",
        },
      ],
    },
    {
      label: "Cryptography",
      items: [
        {
          name: "noble-curves / noble-hashes",
          what: "ed25519 signatures and hashing",
          url: "https://paulmillr.com/noble/",
        },
        {
          name: "scure-bip39 / scure-base",
          what: "your 12 word recovery phrase and did:key encoding",
          url: "https://github.com/paulmillr/scure-bip39",
        },
      ],
    },
    {
      label: "Interface",
      items: [
        {
          name: "Svelte",
          what: "the whole UI",
          url: "https://svelte.dev",
        },
        {
          name: "Vite",
          what: "build tooling and dev server",
          url: "https://vite.dev",
        },
        {
          name: "vite-plugin-pwa + Workbox",
          what: "the installable PWA and its offline cache",
          url: "https://vite-pwa-org.netlify.app",
        },
        {
          name: "Tailwind CSS",
          what: "styling",
          url: "https://tailwindcss.com",
        },
        {
          name: "shadcn-svelte",
          what: "the component layer this UI is built from",
          url: "https://shadcn-svelte.com",
        },
        {
          name: "bits-ui",
          what: "the primitives under it: dialogs, drawers, tooltips",
          url: "https://bits-ui.com",
        },
        {
          name: "Vaul",
          what: "the drawer that slides up on mobile",
          url: "https://github.com/huntabyte/vaul-svelte",
        },
        {
          name: "TanStack Query",
          what: "caching for GIF search and link previews",
          url: "https://tanstack.com/query",
        },
        {
          name: "Lucide",
          what: "the icons",
          url: "https://lucide.dev",
        },
        {
          name: "Shiki",
          what: "syntax highlighting in code blocks",
          url: "https://shiki.style",
        },
        {
          name: "emoji-picker-element",
          what: "the emoji picker",
          url: "https://github.com/nolanlawson/emoji-picker-element",
        },
      ],
    },
    {
      label: "Platform",
      items: [
        {
          name: "Go",
          what: "the language the relay is written in",
          url: "https://go.dev",
        },
        {
          name: "Node.js",
          what: "runs the SFU",
          url: "https://nodejs.org",
        },
        {
          name: "TypeScript",
          what: "the language the frontend is written in",
          url: "https://www.typescriptlang.org",
        },
        {
          name: "nginx",
          what: "serves the frontend bundle",
          url: "https://nginx.org",
        },
        {
          name: "Traefik",
          what: "routes a self-hosted instance's traffic",
          url: "https://traefik.io/traefik",
        },
      ],
    },
    {
      label: "Device",
      items: [
        {
          name: "dtln-rs",
          what: "the noise suppression that cleans up your mic",
          url: "https://github.com/DataDog/dtln-rs",
        },
        {
          name: "dtln-rs-demo",
          what: "the WebAssembly and AudioWorklet build our mic pipeline forks",
          url: "https://github.com/DataDog/dtln-rs-demo",
        },
        {
          name: "dtln-rs-web",
          what: "our fork, reworked from a record-then-process demo into the real-time streaming worklet this app ships",
          url: "https://github.com/FlavioZanoni/dtln-rs-web",
        },
        {
          name: "DTLN",
          what: "the dual-signal LSTM approach the above implements",
          url: "https://github.com/breizhn/DTLN",
        },
        {
          name: "idb",
          what: "local storage for messages, files and identity",
          url: "https://github.com/jakearchibald/idb",
        },
        {
          name: "html5-qrcode / node-qrcode",
          what: "reading and drawing device sync codes",
          url: "https://github.com/mebjas/html5-qrcode",
        },
      ],
    },
  ];
</script>

<div class="flex flex-col gap-4">
  {#each groups as group (group.label)}
    <div class="flex flex-col gap-2">
      <p
        class="text-[10px] font-mono uppercase tracking-wider text-muted-foreground"
      >
        {group.label}
      </p>
      <div class="flex flex-col gap-1.5">
        {#each group.items as item (item.name)}
          <a
            href={item.url}
            target="_blank"
            rel="noopener noreferrer"
            class="flex flex-col gap-0.5 rounded-lg border border-border/50 bg-muted/30 p-2.5
              transition-colors hover:border-primary/40 hover:bg-muted/50"
          >
            <span class="text-xs font-mono font-semibold text-foreground">
              {item.name}
            </span>
            <span class="text-xs font-mono text-muted-foreground">
              {item.what}
            </span>
          </a>
        {/each}
      </div>
    </div>
  {/each}

  <a
    href="/third-party-notices.txt"
    target="_blank"
    rel="noopener noreferrer"
    class="text-xs font-mono text-muted-foreground underline underline-offset-2
      hover:text-foreground transition-colors"
  >
    Full license texts for bundled code
  </a>
</div>
