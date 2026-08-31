<p align="center">
  <img src="frontend/public/pwa-192x192.png" alt="awful.chat" width="120" height="120">
</p>

<h1 align="center">awful.chat</h1>

<p align="center">
  Private, peer-to-peer chat with voice, video and file sharing.<br>
  No accounts, no phone numbers, no server that can read your messages.
</p>

<p align="center">
  <a href="https://github.com/awful-org/awful.chat/actions/workflows/ci.yml"><img src="https://github.com/awful-org/awful.chat/actions/workflows/ci.yml/badge.svg" alt="ci"></a>
  <a href="https://github.com/awful-org/awful.chat/actions/workflows/security.yml"><img src="https://github.com/awful-org/awful.chat/actions/workflows/security.yml/badge.svg" alt="security"></a>
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
  view hides everyone without video. Screen-share audio is scoped to the
  shared window where the OS/browser allow it (Windows 11 / macOS 14.2+ on
  a recent Chrome); everywhere else - including Linux and Firefox - audio
  is only sent once the browser confirms it will not echo, and is withheld
  by default otherwise (opt-in in Settings > Audio).
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

Before the first `docker compose up`, disable docker's userland proxy by setting
`{"userland-proxy": false}` in `/etc/docker/daemon.json` and restarting docker.
Without this, docker spawns one proxy process per published port per protocol.
The SFU media range (500 ports, published for both UDP and TCP) measured at 2000
processes and 8.4 GB of RAM, which will OOM a small VPS. With the flag off, the range uses
iptables DNAT instead, which costs nothing.

`VITE_API_URL`, `VITE_RELAY_MULTIADDR` and the two SFU variables are the
instance's own addresses. They are NOT compiled into the app: the frontend
container writes them to `/config.json` when it starts and the app reads that
before it mounts, so changing one takes a restart rather than a rebuild.

That is also what makes a build checkable. Two instances running the *same
build* - same commit and the same `PLUGIN_SOURCES`, since plugins compile in -
now serve byte-identical JavaScript however differently they are configured,
so a hash published for a commit can be compared against what a running
instance actually serves (see
[awful-verify](https://github.com/awful-org/awful-verify)). Two things still
belong to the build rather than the instance: the commit itself, inlined as
`__APP_COMMIT__` so the app can say what it is running, and the plugin set.

Nothing has to be configured for either. The frontend image builds from the
repo root so `.git` is reachable, and the build reads the refs and the origin
remote directly - no git binary, and nothing for a deployment to set. A build
whose context holds no repository declares no commit.

| Variable | Required | What it is |
| --- | --- | --- |
| `DOMAIN` | yes | public domain of the instance |
| `RELAY_DOMAIN` | no | hostname the relay is served on; defaults to `relay.<DOMAIN>`. Set it when the relay lives under another name (a `dev-relay.example.com`), and point `VITE_API_URL` and `VITE_RELAY_MULTIADDR` at the same name |
| `STACK` | no (yes if two stacks share one server) | unique prefix for this deployment's traefik router/service/middleware names, default `awful`. Traefik names are GLOBAL across every compose project behind one dokploy - a second stack reusing them takes the first one down. A second stack on the same box must also move its ports: `SFU_RTC_MIN_PORT`/`SFU_RTC_MAX_PORT`, `TURN_PORT` + `TURN_MIN_PORT`/`TURN_MAX_PORT` (coturn is host-network; set `TURN_URLS` to match the moved `TURN_PORT`) |
| `ANNOUNCED_IP` | yes | the server's public IP (SFU and coturn announce it) |
| `VITE_API_URL` | yes | relay API origin, e.g. `https://relay.<domain>` |
| `VITE_RELAY_MULTIADDR` | yes | the relay's libp2p multiaddr shown on boot |
| `TURN_SECRET` | yes | shared secret between the relay and coturn (`openssl rand -hex 32`); coturn refuses to start without it |
| `VITE_SFU_URL` | no | SFU websocket URL, defaults to `/sfu` on the app origin |
| `VITE_SFU_URLS` | no | several SFUs, comma-separated (below) |
| `KLIPY_API_KEY` | no | enables the GIF picker (klipy.co) |
| `PLUGIN_SOURCES` | no | plugins fetched at build time, see the [plugin guide](frontend/plugins/README.md) |
| `TURN_URLS` | no | the TURN URL list served to clients, comma-separated (below) |
| `SFU_RTC_MIN_PORT` / `SFU_RTC_MAX_PORT` | no | SFU media range, published and allocated from (default 61000-61499) |
| `TURN_MIN_PORT` / `TURN_MAX_PORT` | no | coturn relay range, one port per allocation (default 49152-50151) |
| `TURN_TOTAL_QUOTA` / `TURN_USER_QUOTA` | no | concurrent TURN allocations, server-wide and per credential |
| `PLUGIN_PROXY_HOSTS` | no | hostnames plugins may reach through the relay's `/plugin-proxy` |
| `PLUGIN_PROXY_SECRETS` | no | `NAME@host=value` list; plugins reference `{{secret:NAME}}`, substituted server-side only for that host |

Firewall: open 80/443 (web), 3478 tcp+udp (TURN), 5349 tcp+udp (TURN TLS,
when configured), the SFU media range (`SFU_RTC_MIN_PORT`-`SFU_RTC_MAX_PORT`,
61000-61499 by default) and coturn's relay range (`TURN_MIN_PORT`-
`TURN_MAX_PORT`, 49152-50151 by default).

The SFU media range must stay above 60999. Linux ephemeral ports span 32768-60999
by default, and docker binds every port in the range when the container starts.
If a single port is already in use by an outbound connection (common after a
reboot), the whole SFU fails to start. A range inside the ephemeral window makes
the SFU start fail at random; ranges above 60999 avoid this entirely.

Both ranges are capacity ceilings, not formalities: one coturn port per
relayed peer, and past the end calls fail outright rather than degrading.

If updating an existing instance to a new deployment, open the SFU media range
(default 61000-61499) in your firewall before redeploying, since the default
range changed from 40000-40499.

### Upgrading an existing instance

The relay container runs as a non-root user (uid 1000) since 2026-08-28. A
`relay_data` volume created by an older deploy is owned by root, and the relay
cannot read its identity key from it - which would change the relay's peerId
and break every client's `VITE_RELAY_MULTIADDR`. Fix the ownership once,
before the first deploy of the new image:

```bash
docker run --rm -v <project>_relay_data:/data alpine chown -R 1000:1000 /data
```

(`docker volume ls | grep relay_data` shows the exact volume name.)

### TURN

`TURN_SECRET` is shared between the relay and coturn. The relay's
`/turn-credentials` endpoint mints a short-lived HMAC credential per client
(coturn's REST convention, 2 hour expiry) and coturn verifies it with
`--use-auth-secret`, so no TURN password ships in the JavaScript bundle.

This is not optional hardening. The bundle used to carry a permanent
`awful:awful`, readable by anyone who opened the JS, which made the server an
open relay for the whole internet - and the people that hurts first are the
ones who need TURN at all. Mobile and CGNAT users cannot connect directly, so
they are the ones who end up relayed, and the relay port range is finite: a
stranger exhausting it does not slow them down, it locks them out.

**More than one TURN server.** Put a comma-separated list in `TURN_URLS`. ICE
gathers a candidate from every entry at once and uses whichever connects
first, so a server near a group of users improves both their connect time and
their relayed latency. Each server runs coturn with the same `TURN_SECRET` and
nothing else in common, so one can live on somebody else's VPS entirely.

**TLS.** `turns:` on 5349 is what gets through restrictive mobile carriers.
Point `TURN_TLS_DIR` at a directory holding `fullchain.pem` and `privkey.pem`,
set `TURN_TLS_ARGS`, and uncomment the volume in the compose file. Traefik
holds 443 on the host, so `turns:` cannot also live there without a second
address.

### More than one SFU

`VITE_SFU_URLS` takes a comma-separated list. Each room is placed on ONE of
them by hashing its room code, so every participant resolves the same server
with no coordination and no extra round trip.

It spreads rooms, not participants: a single room cannot straddle two SFUs
(there is no router cascading between instances), so a room is only as fast as
the server it lands on. The useful arrangement is one SFU near each cluster of
users. Adding a server moves only its own share of rooms - placement is
rendezvous hashing, not modulo - and never disturbs a call in progress, since
the URL is resolved once at join.

Each SFU needs its own host, its own `ANNOUNCED_IP` and its own open media
range.

## License

[Apache 2.0](LICENSE). Community plugins in
[awful-org/awfully-awesome](https://github.com/awful-org/awfully-awesome) are
MIT.

---

Run your own, read the code, trust no one's server, including ours.
