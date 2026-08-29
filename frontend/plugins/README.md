# Writing plugins

Plugins are folders in this directory, bundled with the app at build time and
served to every user of this instance. Think Minecraft mods: whoever runs the
instance decides what ships, everyone on it gets the same set, and adding one
is a folder plus a redeploy. There is no runtime installation and no
sandboxing, because a plugin runs with the same trust as the app itself.

For working examples beyond the built-ins here, browse
[awful-org/awfully-awesome](https://github.com/awful-org/awfully-awesome) -
the curated plugin collection (its waffle-party watch-together exercises
every surface: card, call tile, sidebar widget, media session).

## Anatomy

```
frontend/plugins/
  wheel/
    manifest.ts   loaded eagerly at boot: metadata only, no logic
    index.ts      lazy-loaded on first use: the actual plugin
    WheelCard.svelte
    README.md     usage, install, and instance requirements
```

Every plugin ships a README.md covering: what it does, its commands, how to
install it (built-in vs a PLUGIN_SOURCES entry), and any instance
requirements - proxy hosts, secrets, external accounts. "None" is a valid
and useful answer. The fetcher warns when an installed plugin has no
README.

`manifest.ts` exports metadata only. It must stay import-light: every
manifest loads at boot, and heavy imports here defeat the lazy loading.

```ts
import type { PluginManifest } from "$lib/plugins/api";

export const manifest: PluginManifest = {
  id: "wheel",            // ^[a-z0-9-]{2,32}$, must match the folder name
  name: "Wheel decide",
  description: "Spin a wheel to settle what to play.",
  icon: "🎡",             // an emoji, or "lucide:<kebab-name>" (e.g. "lucide:dices")
  author: "you",          // optional, shown in the plugins settings list
  license: "MIT",         // optional, shown next to the author
  version: "1.0.0",       // optional, shown on the card header and in settings
  // Optional. The settings list GROUPS plugins by this URL's repository
  // root, with the group heading linking there; a deeper path (the plugin's
  // folder in a monorepo) also gets its own source link on the row.
  repository: "https://github.com/you/your-plugin",
  apiVersion: 1,
  commands: [{ name: "wheel", usage: "/wheel Question? option1, option2" }],
};
```

`index.ts` is the plugin:

```ts
import { definePlugin } from "$lib/plugins/api";
import { manifest } from "./manifest";
import WheelCard from "./WheelCard.svelte";

export default definePlugin({
  manifest,
  card: WheelCard,
  initialState: () => ({ spun: false, winner: null as number | null }),
  reduce(state, update, ctx) {
    // First spin wins; every later spin is a no-op.
    if (state.spun || update.data.action !== "spin") return state;
    return { spun: true, winner: pickWinner(update, ctx) };
  },
  commands: {
    wheel: async (args, host) => {
      const options = args.split(",").map((s) => s.trim()).filter(Boolean);
      if (options.length >= 2) await host.sendCard({ options });
    },
  },
});
```

## The contract

**Cards** are chat messages your component renders. They persist, sync to
peers who were offline, and survive reloads. Your card component receives
`{ card, cardState, host }`: the card message, your reduced state, and the
host API. The prop is `cardState`, never `state`: in Svelte 5 a binding
named `state` makes the compiler treat your own `$state(...)` runes as store
subscriptions to that prop, and the component crashes on mount.

The host renders every card inside a framed container with a default
minimum size (about 38rem wide, capped to the chat column on small
screens) and the plugin name and version in its header. Give your card's
root `w-full` and let the frame own the sizing; only cap inner elements
that should not stretch (a banner image, a fixed-size canvas).

**Surfaces.** A card can render in more places than the chat. All are
optional components on the definition, all receive the same
`{ card, cardState, host }` props:

- `widget` - a one-row strip for the sidebar slots (dotted "+ pin" boxes
  above the call controls; users pick a card from any of their rooms).
  Design for a single connection-status-sized row of simple controls -
  plugins without a `widget` component do not appear in the picker.
  Widgets act on the card's own room even while another room is open.
  Set `singletonWidget: true` when only the NEWEST card of your plugin is
  ever worth pinning (a watch-together: old parties are dead parties) -
  the picker then offers just that one and pinning replaces the previous.
  Pair it with `widgetMine(cardState, selfDid)`, a PURE predicate saying
  whether a card is currently the user's (a party they are a member of) -
  the pinned strip then follows the newest card that matches, so joining
  a new party moves the widget automatically.
- `callTile` - the plugin appears in the call grid as a "streamer" (a
  watch-together player, a shared board). Click-to-join like screen
  shares: render nothing loud before the user opts in. Content renders
  locally on every client and only card state syncs, so it costs the SFU
  nothing. Pair it with `callTileActive(cardState)`, a PURE predicate
  deciding whether the newest card of your plugin currently occupies a
  tile, and optionally `callTileViewers(cardState)` returning the display
  names using it - the host shows them in the same audience chip screen
  shares get. Both must be deterministic: every client evaluates them on
  the same folded state. The host renders the tile content inside a
  pointer-events-none layer (clicking the tile focuses it, like any
  stream) - give your interactive controls `pointer-events-auto`, and
  know the mount is PERSISTENT: it survives focus changes and filters, so
  an iframe never reloads mid-call. Call tiles receive one extra prop,
  `chromeVisible` - it mirrors the call's own controls (shown while the
  mouse moves over the call section, hidden on idle in fullscreen); gate
  your control overlays on it so all chrome moves together.

For playback plugins, `host.setNowPlaying({...})` puts the track on the
OS media surface (lock screen, media keys, headsets); the host owns
`navigator.mediaSession` and arbitrates between plugins - latest claimer
wins, null releases your claim. Call it from the surface that RENDERS
playback and make the handlers fire your SYNCED actions - a headset pause
should pause for everyone, exactly like an in-card button. The shape:
`{ title, artist?, artworkUrl?, playing, onPlay?, onPause?, onNext?,
onPrevious? }`.

**Updates** attach to a card. `host.sendUpdate(cardId, data)` persists and
replays; `{ ephemeral: true }` sends live-only (cursors, ticks) and is capped
at ~4 per second per sender. Your `reduce(state, update, ctx)` folds them:
history first in a deterministic order, then live. Keep it pure, keep it a
function of its inputs, and the same state materializes on every client and
every reload.

Two related host calls: `host.cards()` lists the plugin's existing cards in
the host's room (cheap - it reads only card rows), and
`host.sendUpdateImmediately(cardId, data)` is the page-teardown variant of
sendUpdate for `host.onBeforeDisconnect` departure beacons - no async work,
same room binding as sendUpdate.

**Identity**: `ctx.senderDid` and `ctx.senderName` are verified by the host.
Anything inside `update.data` is peer-supplied and untrusted; validate shapes
and clamp values exactly as you would any network input.

**Determinism**: never call Math.random() for anything that peers must agree
on. Derive outcomes from message ids (`ctx.updateId`, `ctx.senderDid`) so
every client computes the same result - inside `reduce` that means hashing
those ids yourself (`reduce` receives no `host`; see wheel's `hashSeed`),
while command handlers and components can use `host.seededRandom(seed)`. Honest limit: the sender of a message
influences its id, so seeded outcomes are consistent and verifiable, not
adversarially fair.

**Size caps**: card payloads up to 16 KB, updates 4 KB, serialized as JSON.
Oversize sends are rejected by the host. Ship bytes through the file layer,
not through card payloads.

**Slash commands** register from the `commands` map; `/wheel a, b, c` calls
your handler with the raw argument string. Commands of disabled plugins do
not autocomplete and do not fire.

**Disabling**: users can toggle any plugin off in settings. Your cards then
render as a neutral fallback naming the plugin; nothing else breaks, and
other users are unaffected.

## Icons

`icon` accepts an emoji or any lucide icon as `lucide:<kebab-name>`
(https://lucide.dev/icons). Cost note: emoji are free; the first lucide icon
rendered on an instance lazy-loads a chunk containing the full icon set, paid
once and only by instances whose plugins use lucide names.

## Calling external APIs

Browsers cannot reach most APIs directly (CORS), and API keys must never
ship in the bundle. The instance relay exposes a generic proxy for both:

```
GET  <VITE_API_URL>/plugin-proxy?url=<https upstream url>
```

The upstream host must be in the instance's `PLUGIN_PROXY_HOSTS` allowlist,
and the url may carry `{{secret:NAME}}` placeholders that the relay fills
from `PLUGIN_PROXY_SECRETS` server-side. Operators should bind secrets to
their host (`STEAM@api.steampowered.com=key`): an unbound secret can be
sent to any allowlisted host, which is a leak the moment a second host is
allowlisted. A 204 means the instance is not configured for your plugin:
say so in the card. Placeholders belong in QUERY STRINGS (values are
query-escaped). GET only, https only, 2 MB response cap, responses cached
~5 minutes, ~10 requests/minute per client. Document the hosts and secrets
your plugin needs in its README.

## Rules

- Do not import from `$lib/transport` internals. The host API is the surface;
  if it is missing something you need, extend the host, not your reach.
- No network calls in `reduce` (it replays; a replayed fetch is a bug).
  Fetching belongs in command handlers or card components, client-side.
- State must rebuild from updates alone. If you cache, cache derivations.
- Test your reducer as a pure function; the repo's vitest setup applies.

## Installing plugins from outside this repo

Set `PLUGIN_SOURCES` on the instance and redeploy - the build fetches each
source into this folder before bundling (the docker-minecraft-server model,
at build time because plugins compile into the app):

```
PLUGIN_SOURCES=https://github.com/you/awful-plugin-dice#v1,you/plugin-pack
```

- Accepted forms: a github url, `user/repo`, either with `#ref` (tag, branch,
  or commit - pin refs for reproducible deploys), or a local path in dev.
- A source can hold ONE plugin (manifest.ts at its root) or a PACK: plugin
  folders at the root or under `plugins/`.
- Removing an entry removes the plugin on the next deploy. Fetched plugins
  never overwrite the built-in ones, and a broken source fails the build
  loudly rather than silently shipping without it.
- A source with no `#ref` fails the build: it fetches HEAD of a third-party
  repo with no integrity check, so the same env value can ship different
  code on the next build. Pin it (`user/repo#<commit-sha or tag>`), or set
  `PLUGIN_SOURCES_ALLOW_UNPINNED=1` to opt in anyway. Every fetched source
  logs its tarball's sha256 so you can confirm two fetches pulled the same
  bytes.
- Trust: a fetched plugin runs with the same trust as the app itself, in
  every user's browser, unsandboxed. Only list sources you trust like your
  own code.

Locally: `PLUGIN_SOURCES=... node scripts/fetch-plugins.mjs` then `pnpm dev`.
Fetched folders are deliberately NOT gitignored - Tailwind's source
detection honors ignore rules, and an ignored plugin builds with none of
its utility classes. A pre-commit hook refuses to commit them instead, so
they show as untracked and stay out of the repo.

## Developing

`pnpm dev` in `frontend/` picks the folder up with hot reload. The registry
skips a plugin with a bad manifest and logs why. Redeploying the instance is
what publishes a plugin to your users.
