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

A plugin that ships WITH this repo also needs a line in
`frontend/tsconfig.app.json`, which names the built-ins one by one. That
folder holds fetched `PLUGIN_SOURCES` plugins too, and this repo's `pnpm
check` must not turn red for somebody else's code - so `plugins/**` is
deliberately not used. Skip the line and your plugin compiles but is never
typechecked, which is how `poll` and `wheel` used `HostApi` without
importing it for months, and how a card can be written against a prop the
host does not pass.

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
  apiVersion: 1,           // must be 1; the registry skips (and logs) anything else
  commands: [{ name: "wheel", usage: "/wheel Question? option1, option2" }],
  hasSettings: true,      // optional: draws the gear for your `settings` surface
  // Optional. Host features you cannot run without: an older app refuses to
  // LOAD the plugin and says so, instead of mounting code that crashes.
  requires: ["confirm"],
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
  // initialState receives the payload sendCard was given - seed from it.
  // Ignoring the argument while your reducer bounds-checks against state
  // means every update is rejected against empty data.
  initialState: (cardData) => ({
    options: (cardData as { options?: string[] })?.options ?? [],
    spun: false,
    winner: null as number | null,
  }),
  reduce(state, update, ctx) {
    // First spin wins; every later spin is a no-op.
    if (state.spun || update.data.action !== "spin") return state;
    return { ...state, spun: true, winner: pickWinner(state, update, ctx) };
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

**Host API at a glance.** Everything a plugin may call lives on `host`;
each entry is detailed in the sections below or right here when one line
covers it:

| Member | What it does |
| --- | --- |
| `sendCard(payload)` | Post a card to the host's room; resolves to its `cardId` |
| `sendUpdate(cardId, data, opts?)` | Attach an update; `{ ephemeral: true }` for live-only |
| `sendUpdateImmediately(cardId, data)` | Teardown-safe sendUpdate for departure beacons |
| `cards()` | This plugin's existing cards in the host's room |
| `onCardStateChange(cb)` | Fires after a persisted update folds; returns unsubscribe |
| `roomCode()` / `selfDid()` | The room this host is bound to; the user's own DID |
| `peers()` | Connected peers as `{ did, name }` |
| `onPeerDisconnect(cb)` / `onBeforeDisconnect(cb)` | A peer left / this page is going away; both return unsubscribe |
| `showLocalCard(data?)` / `closeLocalCard(id)` | Open (returns its id) / close the private floating surface |
| `setNowPlaying(info \| null)` | OS media surface (lock screen, media keys) |
| `ping(did, opts?)` / `isRelayed(did)` | One link probe / is this peer relayed |
| `clockSample(did, opts?)` | One NTP-style clock probe for `estimateClock` |
| `roomContext(opts?)` | Recent human messages of this room, bounded and sanitized |
| `resolveRoomImage(infoHash, opts?)` | An image from `roomContext` as a `Blob`, or null |
| `openMessage(messageId)` | Scroll the chat to a message of this room and flash it |
| `confirm(opts)` | Host-drawn yes/no dialog for THIS user; resolves the choice |
| `callAudio` / `callCapture` | Play into the call / tap the call locally |
| `seededRandom(seed)` | Deterministic PRNG |
| `storage.get(k)` / `storage.set(k, v)` | Device-local key-value store |

**Room context (bots)**: `host.roomContext({ limit? })` returns the recent
HUMAN conversation of the host's room, ascending: text, replies, file
captions, and image METADATA (`{ infoHash, filename, mimeType, width?,
height? }`). Plugin cards and updates, system rows, and other rooms are
never included, and the host enforces hard caps (200 messages, 2000 chars
per message, 32 image entries) whatever `limit` says. Feed an image's
`infoHash` to `host.resolveRoomImage(infoHash, { timeoutMs? })` to get a
displayable `Blob` through the normal attachment path - stored bytes, a
live transfer, or a fresh download from whoever seeds it - or null when
the bytes cannot be produced. `host.openMessage(id)` jumps the chat to a
cited message ("view evidence"); false if it is not this room's message.

**Asking the user**: `host.confirm({ title, message, acceptLabel?,
declineLabel?, timeoutMs?, signal?, fromDid? })` shows a yes/no dialog in
HOST chrome and resolves one of four named results:

| Result | Means |
| --- | --- |
| `"accepted"` | they pressed accept |
| `"declined"` | they pressed decline, or dismissed it |
| `"timeout"` | `timeoutMs` elapsed with no answer |
| `"withdrawn"` | your `signal` aborted, or the session tore down |

Never a bare boolean: "they said no" and "they never looked at it" are
different facts, and a consent flow that cannot tell them apart reports a
silent peer as a refusal. `timeoutMs` (clamped 1s..10min) is what keeps a
group flow from waiting on one person forever, and the host renders the
countdown. Pass a `signal` to withdraw a question that stopped applying -
the asker hung up, the recording already ended - and the dialog closes
itself.

Your plugin's name and icon are drawn by the HOST, so a plugin cannot
impersonate the app or another plugin. `fromDid` extends that to the
cross-peer case: the host resolves the DID against the room's own peers
and renders the name itself, showing nothing when it cannot resolve it -
so "for Bob" is a fact the host vouches for, not a string you supplied.

One dialog shows at a time and one request may be PENDING per plugin;
asking again **rejects** (a `PluginConfirmBusyError`) rather than
resolving, precisely so a dropped request can never read as consent
refused. Catch it, or do not ask twice.

For cross-peer consent (a transcriber asking everyone for permission to
record): send the request as a plugin update, have each peer's copy of
your plugin relay it to `host.confirm` with a `timeoutMs` and
`fromDid: <asker>`, and send the RESULT back as another update, keyed in
your reducer by the host-verified `ctx.senderDid`. Answers then arrive
one by one, live, as each person responds, and a silent peer resolves
`"timeout"` on its own instead of stalling the asker. Only the result
travels; the dialog itself is always local and host-drawn.

Two rules that flow's correctness depends on:

- **The answering side owns the deadline.** An asker may PROPOSE a window
  by putting it in the request, but the receiver decides what its own user
  actually gets - clamp the proposal to a sane floor, or override it
  outright. A peer proposing a one-second window must not be able to make
  your user's dialog unanswerable.
- **An answer is a current state, not a signature.** Consent is revocable:
  the same person can accept, revoke, and accept again, and each answer
  legitimately replaces the last (in the fold order described above, so
  everyone converges on the same latest one). Whatever you gate on the
  answer - a recording, a transcript - must watch the CURRENT value and
  stop the moment it flips, never treat a past `"accepted"` as permanent.

**Settings surface**: a consent flow usually wants preferences to go with
it (an auto-decline, an answering window). Ship a `settings` component and
set `hasSettings: true` - see Surfaces below for the full contract.

**Requiring host features**: a plugin that cannot run without newer host
APIs declares them in the manifest - `requires: ["room-context",
"resolve-room-image"]` - and a host build that lacks any of them refuses
to load the plugin with a clear "needs a newer awful.chat" line instead of
mounting code that crashes. Current feature names: `room-context`,
`resolve-room-image`, `open-message`, `confirm`, `plugin-settings`,
`call-audio`, `call-capture`, `clock-sample`, `local-card`, `now-playing`.
Declare only what you truly cannot function without.

**Per-plugin storage**: `host.storage` is a device-local key-value store,
namespaced per PLUGIN (not per room - prefix your keys with
`host.roomCode()` if you want room scoping). Values are JSON-serialized
into localStorage, so keep them small; a blocked or full store fails
silently (`get` returns `undefined`). Nothing here syncs anywhere - shared
state belongs in cards and updates, and bulk bytes (a soundboard's clips)
belong in your own IndexedDB.

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

**Surfaces.** A plugin can render in more places than the chat. All are
optional components on the definition. `widget` and `callTile` receive the
card props (`{ card, cardState, host }`); `localCard` has its own (below):

- `localCard` - a private, session-only surface opened with
  `host.showLocalCard(data)`. It FLOATS over the invoking client's current
  conversation (bottom-right, above the chat, under the app's menus) with an
  “Only you” marker - a control panel, not a message: it is never signed,
  stored, synchronized, counted as unread, notified, previewed, replied to,
  or reacted to, and it never scrolls away with the history. The component
  receives `{ localCard, host, close }` - `localCard.data` carries whatever
  you passed to `showLocalCard`, and `close()` dismisses the surface (so
  does the host's X button, and `host.closeLocalCard(id)` with the id
  `showLocalCard` returned). One local card exists per plugin and room;
  calling `showLocalCard` again replaces its local data. Use it for
  personal controls such as a device-local soundboard.

- `widget` - a one-row strip for the sidebar slots (dotted "+ pin" boxes
  above the call controls). A pin names your PLUGIN, not a card: the
  picker lists enabled plugins that ship a widget, and the box resolves
  the current subject live, so the strip follows the user between
  parties instead of pointing at the one card they happened to pin.
  Design for a single connection-status-sized row of simple controls -
  plugins without a `widget` component do not appear in the picker.
  Widgets act on their card's own room even while another room is open.
  Card-backed plugins get the newest card `widgetMine(cardState,
  selfDid)` claims (a PURE predicate: "is this card currently the
  user's" - a party they are a member of). When nothing is yours the
  strip waits under a plain "idle" label and RELEASES whatever it last
  followed: a pin that kept showing controls for a party the user had
  left was a remote control for someone else's music. A plugin with no
  `widgetMine` follows its newest card instead. A plugin with no `card`
  surface at all (a device-local soundboard) mounts its widget with
  `card: null` and `cardState: undefined`. `singletonWidget` is
  deprecated and ignored - one pin per plugin is true by construction.
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
- `settings` - app-level configuration, opened from a gear on this
  plugin's row in Settings > Plugins. Announce it with
  `hasSettings: true` in the MANIFEST so the host can draw the gear
  without loading your code; the component is imported on the first
  click. It receives `{ host }` only - no card, no cardState - and the
  host draws the modal chrome (your name, icon and close button), so
  render just the body. The host is not bound to a room here:
  `host.roomCode()` is `""`, which makes the room-scoped calls
  (`sendCard`, `sendUpdate`, `roomContext`, `resolveRoomImage`,
  `openMessage`) meaningless - keep this surface to device-local
  preferences in `host.storage`. The gear only shows while the plugin is
  enabled, and settings persist per device, never synced.

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
every reload. The context carries `{ senderDid, senderName, updateId,
lamport, ephemeral }` - the identity fields are host-verified, and
`ephemeral` tells a reducer this update will never replay.

**That deterministic order is (lamport, senderId, updateId)** - not arrival
order, and not wall-clock time. It is why "allow, then deny, then allow"
ends as *allow* on every screen instead of "whichever packet landed last",
and why a reducer may simply overwrite: the last write in fold order is the
same one everywhere.

**There is deliberately no timestamp in the context.** If you want to show
*when* something happened, put your own `atMs: Date.now()` in the update
payload and bound it in the reducer (`> 1e12 && < 1e13`), the way the watch
tick below does. The host could hand you the message's `timestamp`, but it
would not be worth more: that field is sender-supplied too. So order by
`lamport`, display `atMs`, and treat neither as proof of anything.

The starting state comes from `initialState(cardData)`, which receives the
payload passed to `sendCard` - seed options and questions from it. A
reducer that bounds-checks against state while `initialState` ignores its
argument sees empty data and rejects every update; that exact bug shipped
once, which is why the parameter is worth this paragraph.

Two related host calls: `host.cards()` lists the plugin's existing cards in
the host's room (cheap - it reads only card rows), and
`host.sendUpdateImmediately(cardId, data)` is the page-teardown variant of
sendUpdate for `host.onBeforeDisconnect` departure beacons - no async work,
same room binding as sendUpdate.

**Measuring a link**: `host.ping(did, { timeoutMs })` sends one round-trip
probe to a peer and resolves to milliseconds, or `null` when it did not
answer in time - null is loss, never "very slow", and folding a timeout in
as a number is how an average stops meaning anything. It exists because a
plugin has no peer-addressed channel of its own: `sendCard` and `sendUpdate`
are room broadcasts through the signed pipeline, so timing one of those
measures signing and fan-out rather than the link. The peer answers the
probe before any app work, so it reports the connection, not the
application.

It is one probe, not a schedule. The cadence, the window and the statistics
are yours. Two things worth knowing before you pick an interval: probing
faster than the round trip puts several probes in flight, which adds
traffic to the link you are measuring and smears one queueing event across
several samples; and network conditions change on the scale of a few
hundred milliseconds, so sampling much slower than that gives you unrelated
snapshots rather than a picture. The built-in `ping` plugin starts at 500ms
and backs off to twice the measured round trip.

`host.isRelayed(did)` says whether a peer is reached through a relay rather
than directly. A relayed hop is peer to relay to peer and structurally
slower, so anything reporting latency should label it - unlabelled, it reads
as somebody's connection being bad when the finding is that the two of you
never got a direct one.

**Identity**: `ctx.senderDid` and `ctx.senderName` are verified by the host.
Anything inside `update.data` is peer-supplied and untrusted; validate shapes
and clamp values exactly as you would any network input.

**Determinism**: never call Math.random() for anything that peers must agree
on. Derive outcomes from message ids (`ctx.updateId`, `ctx.senderDid`) so
every client computes the same result - inside `reduce` that means hashing
those ids yourself (`reduce` receives no `host`; see wheel's `hashSeed`),
while command handlers and components can use `host.seededRandom(seed)`.
Honest limit: the sender of a message influences its id, so seeded outcomes
are consistent and verifiable, not adversarially fair.

**Size caps**: card payloads up to 16 KB, updates 4 KB, serialized as JSON.
Oversize sends are rejected by the host. Ship bytes through the file layer,
not through card payloads.

**Slash commands** register from the `commands` map; `/wheel a, b, c` calls
your handler with the raw argument string. Commands of disabled plugins do
not autocomplete and do not fire.

**Call sounds** use `host.callAudio`. `blockedReason()` returns
`"not-in-call"`, `"deafened"`, or `null`. `play(blob)` decodes a local audio
blob and mixes the clip into the user's existing outgoing P2P voice track
after microphone noise suppression. It returns `{ id, durationMs }`;
`stop(id)` stops that clip, `stop()` stops every clip this plugin started.
Sounds are scoped to your plugin: your clips can layer, and you can never
stop (or evict) another plugin's audio. Playback policy is yours - want
one-at-a-time, stop before you play. The host only enforces a per-plugin
resource ceiling: past five concurrent clips it evicts your oldest. Host
policy caps a decoded clip at `callAudio.maxDurationMs` and the blob at
2MB - validate against the exposed limit rather than hardcoding it.
The host accepts a Blob, never a URL, and sends no plugin message or file
transfer. The clips pass through a limiter; the microphone path does not, so
voice is untouched when nothing plays. Microphone mute still gates only
microphone samples, so an intentional call sound can play while muted. Stop
playback when your surface unmounts.

**Call capture** uses `host.callCapture` - the tap for a recorder or
transcriber. `streams()` returns a snapshot with one entry per audible
participant: `self: true` is the OUTGOING stream (post noise suppression,
call sounds included - exactly what peers hear, so a muted mic captures
silence), and each peer entry carries their display name. Every stream is a
CLONE your plugin owns: stop its tracks when you are done, and take a fresh
snapshot when `onChange(cb)` fires (people joining or leaving). Nothing
captured leaves the device through this API - what you do with the bytes
(a local recording, a transcript) is your plugin's responsibility to make
obvious to its user.

**Disabling**: users can toggle any plugin off in settings. Your cards then
render as a neutral fallback naming the plugin; nothing else breaks, and
other users are unaffected.

## Icons

`icon` accepts an emoji or any lucide icon as `lucide:<kebab-name>`
(https://lucide.dev/icons). Cost note: emoji are free; the first lucide icon
rendered on an instance lazy-loads a chunk containing the full icon set, paid
once and only by instances whose plugins use lucide names.

## Shared components

`$lib/plugins/ui` is the one place to import a host component from. Today it
exports `Tip`, a tooltip for a single control:

```svelte
import { Tip } from "$lib/plugins/ui";

<Tip text="Next track">
  {#snippet children(props)}
    <button {...props} onclick={next} aria-label="Next track">
      <SkipForward class="size-4" />
    </button>
  {/snippet}
</Tip>
```

Prefer it over the native `title` attribute, which cannot be styled, has a
delay the browser picks, and looks foreign next to the rest of the app.

Two things about the shape. The trigger props go on YOUR element rather than
Tip wrapping it in a button of its own - so the tooltip attaches to the real
control, there are no nested interactive elements, and it opens on keyboard
focus. And a tooltip is not an accessible name: an icon-only control still
needs its own `aria-label`, because `Tip` renders a visual hint, not a label
screen readers use.

Import from `$lib/plugins/ui`, never from `$lib/components/...` directly.
Everything under `components/` is the app's own and moves without warning;
only what this module exports is a promise, tied to the `apiVersion` in your
manifest. If you need something that is not there, ask - and expect the
answer to be a `host` method rather than a component where that is possible,
since data is a smaller promise for the host to keep than layout.

## Synchronizing playback across peers

`$lib/plugins/watch` is a shared, pure library for any plugin that keeps a
media element in step across peers, so a watch-together plugin does not
need to re-invent the same control loop. Every export is pure and
synchronous: no DOM, no timers, no network call, no `$lib/transport`
import.

```ts
/** One authoritative playback snapshot. A timestamp and a rate, never a bare position. */
export type WatchTick = {
  paused: boolean;
  /** media position in seconds, true at `atMs` on the sender's clock */
  position: number;
  /** sender wall clock, ms since epoch */
  atMs: number;
  /** playback rate; 1 is normal */
  rate: number;
  /** monotonically increasing per sender, for ordering ticks inside one room */
  seq: number;
};
export type ClockSample = { t0: number; t1: number; t2: number; t3: number };
export type ClockEstimate = { offsetMs: number; rttMs: number; samples: number };
/** NTP-style offset from round-trip samples, median-filtered. */
export function estimateClock(samples: readonly ClockSample[]): ClockEstimate;
/** Where the tick says playback is, right now, on the local clock. */
export function projectPosition(tick: WatchTick, nowMs: number, offsetMs: number): number;
export type CorrectionAction = "none" | "seek" | "rate" | "pause" | "resume";
export type Correction = { action: CorrectionAction; targetPosition: number; rate: number; driftMs: number };
/** The control law. Small drift is corrected by rate, large drift by seek. */
export function decideCorrection(
  local: { position: number; paused: boolean; rate: number },
  tick: WatchTick,
  nowMs: number,
  offsetMs: number,
  cfg?: Partial<WatchSyncConfig>,
): Correction;
export type WatchSyncConfig = { seekThresholdMs: number; rateThresholdMs: number; slowRate: number; fastRate: number; maxRateCorrectionMs: number };
export const DEFAULT_WATCH_SYNC: WatchSyncConfig;
```

A `WatchTick` is a snapshot, never a bare position: a lone number ages the
moment it is written, and two peers reading it at different instants land
at different places with nothing to correct the drift afterward. The
timestamp and rate are what let every peer compute where playback actually
is right now, on their own clock, via `projectPosition`.

The control law follows Syncplay's published constants
(`syncplay/constants.py`): ignore drift under `rateThresholdMs`, correct
larger drift by nudging `rate` instead of seeking - a 5% speed change is
neither visible nor audible, a seek is both - and only seek once drift
passes `seekThresholdMs`. `DEFAULT_WATCH_SYNC` carries Syncplay's own
numbers where Syncplay names one directly: `seekThresholdMs: 4000`
(`DEFAULT_REWIND_THRESHOLD`), `rateThresholdMs: 1500`
(`DEFAULT_SLOWDOWN_KICKIN_THRESHOLD`), `slowRate: 0.95` (`SLOWDOWN_RATE`),
`maxRateCorrectionMs: 100` (`SLOWDOWN_RESET_THRESHOLD`). `fastRate: 1.05` is
the one value with no matching named constant to quote - Syncplay's own
fast-forward thresholds carry no paired speedup rate, so this is derived
from the same "a small rate change is neither visible nor audible" design
reasoning, applied symmetrically to the behind-schedule case.

Clock offset is a plugin's own job to gather, through `host.clockSample`:
each call is one probe returning the four NTP timestamps (t1 = t2, the peer
answers inline), or null on loss or against a build whose probes carry no
clock. Sample several, hand them to `estimateClock`, which median-filters
them into an offset. `decideCorrection` never touches the network itself.

One YouTube-specific note: the iframe player rounds fractional playback
rates to its discrete steps, so Syncplay's rate-nudge lane does not exist
there - act only on `"seek"` corrections and treat `"rate"` as none, which
is what waffle-party's adoption does.

The first consumer is `anime-party` in
[awful-org/awfully-awesome](https://github.com/awful-org/awfully-awesome),
fetched via `PLUGIN_SOURCES` like any other plugin - see its README for
the full watch-party built on top of this library.

## Calling external APIs

Browsers cannot reach most APIs directly (CORS), and API keys must never
ship in the bundle. The instance relay exposes a generic proxy for both:

```ts
import { proxyUrl } from "$lib/plugins/api";

const res = await fetch(proxyUrl("https://api.example.com/thing?key={{secret:NAME}}"));
```

Call it per request. Do NOT build the url yourself from `import.meta.env`:
vite compiles that value into the bundle, which puts the instance's own
address into code that is supposed to be identical everywhere, and an
instance that set nothing would silently send your users' requests to
whichever origin you hardcoded as a fallback. Both of those have happened.
The host reads its api origin at runtime, so there is nothing to inline.

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
- Never read `import.meta.env`. Vite replaces those reads with their values
  at build time, so anything instance-specific gets compiled into the bundle -
  which makes every instance's JavaScript different and its build
  unverifiable. `fetch-plugins` fails the build on this. Use `apiUrl()` from
  `$lib/runtime-config`, or `proxyUrl()` below, both read at call time.

### Your plugin is part of what people verify

Plugins compile INTO the app; they are not loaded separately at runtime. Two
consequences worth knowing before you publish one:

- The bundle an instance serves depends on its plugin set, so your code is
  inside the bytes anyone checking that instance will hash. A change you push
  changes what every instance running you serves.
- An instance is expected to pin you (`PLUGIN_SOURCES=owner/repo@sha`).
  Tag releases, and do not rewrite history on a tag people pin - a pinned ref
  that changes underneath is exactly what pinning is meant to prevent.

## Installing plugins from outside this repo

Set `PLUGIN_SOURCES` on the instance and redeploy - the build fetches each
source into this folder before bundling (the docker-minecraft-server model,
at build time because plugins compile into the app):

```
PLUGIN_SOURCES=https://github.com/you/awful-plugin-dice#v1,you/plugin-pack
```

- Accepted forms: a github url, `user/repo`, either with `@ref` or `#ref`
  (tag, branch or commit), or a local path in dev. Prefer `@` in an
  environment variable: a `.env` file treats `#` as the start of a comment,
  so `owner/repo#sha` arrives at the build as `owner/repo`.
- A source can hold ONE plugin (manifest.ts at its root) or a PACK: plugin
  folders at the root or under `plugins/`.
- Removing an entry removes the plugin on the next deploy. Fetched plugins
  never overwrite the built-in ones, and a broken source fails the build
  loudly rather than silently shipping without it.
- A source with no ref fails the build: it fetches HEAD of a third-party
  repo with no integrity check, so the same env value can ship different
  code on the next build. Pin it (`user/repo@<commit-sha>`), or set
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
