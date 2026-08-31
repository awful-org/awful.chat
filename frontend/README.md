# awful.chat frontend

Svelte 5 + TypeScript + Vite PWA. See the [root README](../README.md) for
architecture and the full dev setup, and [docs/spec.md](../docs/spec.md)
for the data model and wire protocols.

```sh
pnpm install
pnpm dev      # needs the relay running (see root README)
pnpm test     # vitest
pnpm check    # svelte-check + tsc
pnpm build
```

Env (`../.env`): `VITE_RELAY_MULTIADDR` (libp2p relay), `VITE_API_URL`
(og/klipy proxies), `VITE_SFU_URL` (mediasoup signaling). These are read by
`pnpm dev` only. A built app reads the same three values from `/config.json`,
which the container writes from its environment at start, so a production
bundle carries no instance addresses at all, and two differently configured
instances of the same commit and plugin set serve identical bytes.

Layout: `src/lib/transport/` (libp2p, DMs, sync, files, calls),
`src/lib/identity/` (keys, unlock, device sync), `src/lib/storage.ts`
(IndexedDB), `src/lib/components/` (UI).
