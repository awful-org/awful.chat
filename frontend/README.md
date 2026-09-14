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
# Dependency security

Run `pnpm audit --prod`; the weekly security workflow enforces this check.
The frontend is a browser application. Its pnpm overrides remove native-only
dependency branches already excluded by upstream browser entry points:
`@libp2p/webrtc`'s React Native adapter, WebTorrent's `load-ip-set`, and
the v9 BitTorrent tracker's UDP-server `ip` dependency. These overrides are
not suitable for running these packages as Node torrent servers or React Native
apps. Native WebRTC in the browser and WebSocket torrent trackers remain enabled.

The overrides also keep ws 7/8 and ip-address 10 on security-patched versions
within their existing major versions. Svelte's minimum is 5.57.0. Recheck the
upstream browser mappings, audit, tests and production build when upgrading
these packages; do not silence advisories to compensate for a dependency change.
