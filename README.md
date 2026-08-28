<p align="center">
  <img src="frontend/public/pwa-192x192.png" alt="awful.chat" width="120" height="120">
</p>

<h1 align="center">awful.chat</h1>

<p align="center">
  Private, peer-to-peer chat with voice, video and file sharing.<br>
  No accounts, no phone numbers, no server that can read your messages.
</p>

Your identity is a BIP39 mnemonic that never leaves your device. Messages
travel peer-to-peer over libp2p with end-to-end encryption, files move
browser-to-browser over WebTorrent, and voice is direct WebRTC. The servers
you (or anyone) can self-host only introduce peers to each other and route
group video.

## Features

- **Rooms** with shareable invite links, message history that syncs
  peer-to-peer, replies, emoji reactions, code blocks with syntax
  highlighting, and link previews.
- **Direct messages** with an offline queue, delivery and read receipts, and
  a phonebook of saved contacts.
- **@Mentions** with autocomplete: tamper-proof (they ride inside the signed
  message), rename-proof (always show the current name), and the mentioned
  person gets a highlighted message and a notification.
- **Voice calls**, fully peer-to-peer, with optional neural noise
  suppression (DTLN) and per-peer volume.
- **Camera and screen share** at 30 fps through a self-hosted SFU: sharing is
  opt-in to watch, the sharer sees who is watching, and a streamers-only
  view hides everyone without video.
- **Files and media**: WebTorrent transfers with no public trackers, inline
  images, video, audio and GIFs, a GIF picker with saved favorites, and
  small files delivered inside the message itself so they load instantly.
- **Profiles**: avatar, banner (image or GIF), a colored tag chip, bio, and
  name effects (gradient, shimmer, glow, rainbow).
- **Plugins**: instance-level, Minecraft-mods style. Drop a folder or point
  `PLUGIN_SOURCES` at GitHub repos and redeploy; ships with `/wheel` and
  `/poll`, with more at
  [awful-org/awfully-awesome](https://github.com/awful-org/awfully-awesome).
  See [frontend/plugins/README.md](frontend/plugins/README.md).
- **Multi-device**: several devices on one identity, QR device sync,
  encrypted backups, and optional biometric unlock (fingerprint or security
  key via WebAuthn PRF).
- **Encrypted at rest**: every content-bearing record in the local database
  is AES-GCM ciphertext keyed off your identity - locked, stolen, or
  forensically carved, message bodies, files and profiles are noise. (Sync
  bookkeeping - room codes, sender ids, lamport counters - stays readable;
  it is what lets devices sync without decrypting anything.) An optional duress password typed at the
  unlock screen silently erases the device and shows a fresh install;
  your account survives elsewhere via the recovery phrase. This composes
  with, not replaces, your OS's full-disk encryption.
- **Installable PWA**: opens offline with your full history; sending waits
  for peers.

## How private is it, exactly

| Traffic | Path | Who can read it |
| --- | --- | --- |
| Messages, DMs, files | peer-to-peer (relay forwards ciphertext) | only participants |
| Voice | direct WebRTC between peers | only participants |
| Camera / screen share | mediasoup SFU | participants **and the SFU operator** |

The one honest exception is group video: an SFU must decrypt media to route
it, so whoever runs that server can see streams that pass through it. Text,
DMs, files and voice never touch the SFU. Run your own instance and the
exception is you.

## Architecture

```
frontend/   Svelte 5 + Vite PWA - the app
relay/      Go libp2p relay: circuit relay v2, rendezvous, /og, /klipy, /turn-credentials
sfu/        mediasoup SFU (Node) for group video and screen share
coturn      TURN server for voice fallback (compose only, stock image)
```

- **Text** rides gossipsub room topics between browsers; the relay forwards
  encrypted frames it cannot read (noise, e2e between peers). History syncs
  peer-to-peer via lamport watermarks.
- **DMs** are direct libp2p streams with tagged envelopes (chat, delivery
  ack, read ack) and an offline queue retried when the peer returns.
- **Files** are WebTorrent over the peers' own WebRTC connections, signalled
  through libp2p; there are no trackers, peers are introduced by the room.
  Small attachments (under 5 MB) also persist in IndexedDB and re-seed, and
  files under 512 KB travel inline in the message.
- **Identity** is BIP39 mnemonic to ed25519 to did:key, encrypted at rest.
  Each device carries its own libp2p key, separate from the identity key, and
  proves which did:key is behind its peerId by signing the binding.

Full data model, sync protocol, wire formats and crypto details:
[docs/spec.md](docs/spec.md). Plugin surface design:
[docs/plugin-surface.md](docs/plugin-surface.md).

## Development

```sh
docker compose -f docker-compose.dev.yml up   # relay + frontend + sfu
# frontend: http://localhost:5173
```

Or run pieces directly:

```sh
cd frontend && pnpm install && pnpm dev
cd relay && go run .
cd sfu && npm install && npm start
```

Tests and checks:

```sh
cd frontend && pnpm test    # vitest: crypto, peer auth, dm codec, storage,
                            # wire types, plugins, mentions, profile validation
cd frontend && pnpm check   # svelte-check + tsc
cd relay && go test ./...   # rendezvous registry + TURN credentials
```

The DTLN noise-suppression worklet is built in a separate repo,
[dtln-rs-web](https://github.com/FlavioZanoni/dtln-rs-web). Both
`frontend/public/audio-worklet.js` and `frontend/src/lib/audio/worklet-url.ts`
are generated from it - never edit either by hand:

```sh
cd ../dtln && npm run sync   # rebuild, copy the bundle here, and stamp a
                             # fresh ?v= hash into worklet-url.ts
```

That hash is load-bearing: the service worker caches the worklet forever, so a
new build without a new URL never reaches anyone who has opened the app before.
The dtln repo's own page (`npm run serve`) self-checks the worklet - worth
running before syncing, since a broken worklet fails silently rather than
loudly.

## Self-hosting

`docker-compose.dokploy.yml` runs relay + sfu + coturn + frontend behind
Traefik. One VPS is enough; give it swap before the first deploy, the
frontend build is memory-hungry. Copy [.env.example](.env.example) to `.env`
as a starting point.

| Variable | Required | What it is |
| --- | --- | --- |
| `DOMAIN` | yes | public domain of the instance |
| `ANNOUNCED_IP` | yes | the server's public IP (SFU and coturn announce it) |
| `VITE_API_URL` | yes | relay API origin, e.g. `https://relay.<domain>` |
| `VITE_RELAY_MULTIADDR` | yes | the relay's libp2p multiaddr shown on boot |
| `VITE_SFU_URL` | no | SFU websocket URL, defaults to `/sfu` on the app origin |
| `KLIPY_API_KEY` | no | enables the GIF picker (klipy.co) |
| `PLUGIN_SOURCES` | no | plugins fetched at build time, see the [plugin guide](frontend/plugins/README.md) |
| `TURN_SECRET` | no | switches TURN to short-lived credentials (below) |
| `TURN_URLS` | no | override the TURN URL list served to clients |
| `PLUGIN_PROXY_HOSTS` | no | hostnames plugins may reach through the relay's `/plugin-proxy` |
| `PLUGIN_PROXY_SECRETS` | no | `NAME@host=value` list; plugins reference `{{secret:NAME}}`, substituted server-side only for that host |

Firewall: open 80/443 (web), 3478 tcp+udp (TURN), 5349 tcp+udp (TURN TLS,
when configured), the SFU port range (40000-40499 by default) and coturn's
relay range (49152-49251).

### TURN credentials (optional hardening)

By default coturn uses a static username/password baked into the client
bundle, which means anyone can relay traffic through your server. To issue
short-lived per-session credentials instead:

1. Set a strong `TURN_SECRET` on the relay service.
2. Switch coturn from `--lt-cred-mech --user=awful:awful` to
   `--use-auth-secret --static-auth-secret=<same TURN_SECRET>`.

The relay's `/turn-credentials` endpoint then hands the frontend HMAC
credentials (coturn REST convention) expiring after 12 hours. With
`TURN_SECRET` unset the endpoint returns 204 and clients keep the static
fallback, so this is safe to leave off until both sides are configured.

## License

[Apache 2.0](LICENSE). Community plugins in
[awful-org/awfully-awesome](https://github.com/awful-org/awfully-awesome) are
MIT.

---

Run your own, read the code, trust no one's server, including ours.
