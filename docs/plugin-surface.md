# Plugin surface plan

Instance-shipped client plugins, "Minecraft mods" model: a `frontend/plugins/`
folder, bundled at build time, served to every user of the instance. No
third-party code at runtime, no server-side plugin logic, no sandboxing:
plugins share the exact trust level of the app bundle itself, because the
operator already ships all the code every visitor runs.

## Status: shipped, and grown past this plan

This document is the original v1 design and review record; everything in it
was built. The living author contract is `frontend/plugins/README.md` - when
this file and the README disagree, the README wins. What has grown since:

- Manifest gained `name`-adjacent metadata: `version`, `author`, `license`,
  `repository` (the settings page groups plugins by repository origin and
  links it), and `icon` accepts `lucide:*` names, not just emoji.
- External plugin sources: the frontend Dockerfile fetches extra plugin repos
  at build time via `PLUGIN_SOURCES` (e.g. `awful-org/awfully-awesome`),
  deleting any fetched `.gitignore` so Tailwind scans their markup. A
  pre-commit hook keeps fetched plugins out of the app repo.
- Host API grew: `cards()` and `sendUpdateImmediately` (host-bound, room
  targeted), a now-playing media surface (`setNowPlaying`), and call-view
  plugin TILES with join presence - the "no surfaces outside chat" non-goal
  fell (waffle-party exercises all of it).
- A server-side component exists after all: the relay's plugin proxy
  (`PLUGIN_PROXY_HOSTS` / `PLUGIN_PROXY_SECRETS`) so plugins can call
  allowlisted third-party APIs without leaking client IPs or shipping keys.
- Signatures moved to sigV 3 (canonical binds type + roomCode); the "zero
  signature-format changes" note below describes the v2 era.
- Settings panel leads with a trust notice (plugins are unvetted, run with
  app-level access, can degrade performance).
- Reference plugins: wheel took an optional question (`/wheel Question? a, b`),
  and poll shipped as planned.

## Goals

- Adding a plugin = dropping a folder in `frontend/plugins/` and redeploying.
- Plugins can define chat cards, react to updates from other peers, and add
  slash commands, without touching the wire layer or core files.
- Users see a "Plugins" panel in settings: icon, name, description, per-user
  enable toggle.
- Two reference plugins prove the API: wheel (deterministic shared outcome)
  and poll (multi-peer persisted state).

## Non-goals (v1)

- Runtime plugin loading without redeploy, marketplaces, permissions UI.
- Surfaces outside chat: sidebar panels, call-view widgets, settings pages,
  message transforms.
- Server-side plugin components.
- Cross-instance version negotiation beyond the fallback card.

## 1. Loader and registry

New: `frontend/src/lib/plugins/registry.ts`.

- Discovery: `import.meta.glob("../../../plugins/*/index.ts")` in lazy mode.
  Vite splits each plugin into its own hashed chunk, downloaded on first use,
  deps shared with the app (same pattern as the webtorrent/mediasoup lazy
  imports). Manifests must be available WITHOUT loading plugin code, so each
  plugin also has `manifest.ts` loaded eagerly via a second glob with
  `{ eager: true }`: tiny objects, no code.
- `definePlugin(def)` in `src/lib/plugins/api.ts` is the typed entry:

```ts
interface PluginManifest {
  id: string;           // ^[a-z0-9-]{2,32}$, folder name must match
  name: string;
  description: string;  // one line, shown in settings
  icon: string;         // emoji, keeps v1 free of asset plumbing
  apiVersion: 1;
}

interface PluginDefinition {
  manifest: PluginManifest;
  // Svelte component rendering a card. Props: { card, state, host }.
  card?: Component;
  // Pure reducer. Host feeds persisted updates in lamport order (history
  // replay first, then live), ephemeral updates live only.
  reduce?: (state: unknown, update: PluginUpdate, ctx: UpdateCtx) => unknown;
  initialState?: () => unknown;
  commands?: Record<string, (args: string, host: HostApi) => void | Promise<void>>;
}

interface UpdateCtx {
  senderDid: string;     // host-verified, never from payload
  senderName: string;
  updateId: string;      // message id, stable across peers
  lamport: number;
  ephemeral: boolean;
}

interface HostApi {
  // Built by GENERALIZING sendMessage, never as a parallel path: signing
  // (sigV2), lamport assignment (room counter vs wall-clock nextDmLamport
  // for dm- rooms), putMessage, setWatermark, appendSorted, markRoomSeen,
  // noteRoomActivity all live there, and parallel send paths are where this
  // codebase's historical bugs came from.
  sendCard(payload: unknown): Promise<string>;          // returns cardId
  sendUpdate(cardId: string, payload: unknown, opts?: { ephemeral?: boolean }): Promise<void>;
  roomCode(): string;
  selfDid(): string;
  peers(): Array<{ did: string; name: string }>;
  seededRandom(seed: string): () => number;             // deterministic PRNG
  storage: { get(k: string): Promise<unknown>; set(k: string, v: unknown): Promise<void> };
}
```

- Registry validates manifests at startup (id regex, unique, apiVersion
  match); a bad plugin is skipped with a console error, never crashes boot.
- apiVersion gate: loader refuses mismatched plugins with a settings-panel
  note instead of undefined behavior.

## 2. Wire protocol

Two new chat-class message types plus one ephemeral type in
`src/lib/types/message.ts` (enum at line 3):

- `PluginCard = "plugin_card"`: persisted, syncs through digests/batches.
- `PluginUpdate = "plugin_update"`: persisted, same treatment.
- `PluginEphemeral = "plugin_ephemeral"`: wire only, never stored.

Review finding (blocker, fixed here): `isChatMessage` is dead code with zero
callers. The REAL persistence gate is the dispatcher's explicit case list in
`transport.svelte.ts` (the `case Text/Reply/Reaction/File` block, which also
carries the chat-over-pubsub forgery guard and `_verifyIncoming`). The work
list is therefore: the dispatcher case list, `wireToMessage`, the send side,
and `isChatMessage` updated only for hygiene.

Payload placement: the JSON payload is stringified into `msg.content`, as
`{ pluginId, cardId?, data }`. This is deliberate: `canonicalContentV2`
(messaging.ts) already signs `content`, so plugin payloads are covered by the
existing v2 signature with zero signature-format changes. `cardId` for updates
is the card's message id.

Host-side validation on receive (mirror of profile-meta: pure function
`src/lib/plugins/validate.ts`, unit tested):
- content parses as JSON, pluginId matches `^[a-z0-9-]{2,32}$`
- caps: card payload <= 16 KB, update <= 4 KB, ephemeral <= 4 KB (JSON string
  length). Oversize is dropped with a console warn.
- Sender identity comes exclusively from the verified message path (senderId
  and the peerId-DID binding), NEVER from the payload. Same rule the DM layer
  enforces.
- Unknown or disabled pluginId: card renders the fallback ("uses the X
  plugin"); updates and ephemerals are dropped.
- Old clients: live messages of unknown type are ignored, but HISTORY SYNC
  stores any verified message type-agnostically and old MsgRender's default
  branch renders raw content - old builds would show plugin JSON as chat
  lines. Mitigation already shipped ahead of this surface: visibleMessages in
  ChatView is an allowlist of renderable types, so any build carrying that
  filter hides unknown types instead. Clients older than the filter remain
  exposed until they reload (the vite:preloadError auto-reload shortens
  this); accepted as a transient rollout artifact on a same-instance user
  base.
- Side-channel leaks (review findings, all in scope for v1):
  - `getUnreadCount` must exclude `PluginUpdate` (renders nothing, must not
    light the badge) alongside `Reaction`.
  - `notifyMessage` must exclude `PluginUpdate`, and `PluginCard`
    notifications use a friendly body from the manifest ("posted a wheel"),
    never raw content.
  - The room/DM list last-message preview uses `last.content` verbatim: add
    a per-type preview mapper ("[wheel]" for cards, walk back past
    non-renderable types for updates).

## 3. Card state

New: `src/lib/plugins/state.svelte.ts`.

- Per-card state store: `cardStates: Map<cardId, unknown>` in a $state map.
- On first render of a card, the host queries storage for all PluginUpdate
  messages in that room referencing the cardId (the reaction pattern:
  `getAllMessages(roomCode)` filter), sorts by `(lamport, senderId, id)` -
  the codebase's own MSG_ORDER comparator (lamport, senderId) extended with
  the id as cheap insurance for DM rooms whose lamports are wall-clock ms.
  One comparator, shared with MSG_ORDER, not a second ordering. Folds through
  the plugin's `reduce`, caches the result.
- Eviction: cardStates clears on room switch and disconnect, mirroring the
  cleanup discipline _disconnectWithoutBroadcasting applies to the other
  session maps - unbounded per-card state is the exact leak shape
  fileTransfers needed fixing for.
- Live updates (own sends included) fold incrementally. Ephemeral updates
  fold but are marked so a rebuild from storage does not expect them.
- Determinism rule for reference plugins: any randomness derives from
  `seededRandom(messageId)`. Same fold order + same seeds = identical state on
  every client, late joiners included.

## 4. Rendering

`MsgRender.svelte` gets a `PluginCard` branch: look up pluginId in the
registry, lazy-load the plugin chunk (skeleton while loading), mount the
card component with `{ card, state, host }`. Fallback card for unknown or
disabled plugins shows icon-less neutral chip with the plugin id. Card width
constraints match existing file cards. PluginUpdate messages render nothing
(they are data, not chat lines), but they must not break pagination or unread
counts: they are excluded from the unread badge the same way reactions are
(verify how Reaction is counted and mirror it).

## 5. Slash commands

- `ChatView.svelte` composer: on send, if the text matches `^/([a-z0-9-]+)\s?(.*)$`
  and the command is registered by an enabled plugin, invoke the handler
  instead of sending a text message. Unknown command: inline hint under the
  composer, message not sent (prevents leaking typos as public messages).
- Autocomplete: when the composer starts with "/", a small popup lists
  matching commands with plugin icon and description, keyboard navigable.
  Reuses the mention/emoji popup pattern if one exists, otherwise a minimal
  list styled like EmojiPickerPopup.

## 6. Settings panel

- `SettingsDialog.svelte` (tabs at line 58): new tab "Plugins" with a Puzzle
  icon, new component `src/lib/components/settings/PluginSettings.svelte`.
- Lists every discovered manifest: icon, name, description, version, and a
  toggle. Toggle state is device-local (display-prefs pattern,
  `awful:plugin-disabled:v1` key holding a JSON array of disabled ids, in
  `src/lib/plugins/prefs.svelte.ts`).
- Disabled = fallback rendering + commands removed from autocomplete and
  dispatch. Other peers unaffected.

## 7. Reference plugins

`frontend/plugins/wheel/`:
- `/wheel Valorant, CS2, Deep Rock` posts a card with the options.
- Card shows the wheel; any participant can hit "Spin" once per card: the
  FIRST spin update in the fold order wins, later spins are no-ops in the
  reducer. Winner index derives from
  `seededRandom(hash(cardId + spinUpdateId + senderDid))`.
  The animation eases onto the predetermined winner. Result line names the
  winner and who spun.
- Fairness, stated honestly: the outcome is VERIFIABLE and CONSISTENT for
  everyone, not adversarially fair - the spinner generates the update id and
  could grind ids until the seed favors them. The composite seed raises the
  cost, commit-reveal would eliminate it and is deliberately punted;
  friends-scale trust is the operating assumption.

`frontend/plugins/poll/`:
- `/poll Question? A, B, C` posts a card.
- Vote buttons send persisted updates `{ vote: i }`; reducer keeps last vote
  per senderDid; card shows live tallies and who voted (names, since rooms
  are small).

## 8. Tests and verification

- Unit: validate.ts caps and shapes; seededRandom stability (fixed vectors);
  wheel reducer (first spin wins, deterministic winner); poll reducer (last
  vote per did). Registry: duplicate id, bad manifest skipped.
- svelte-check 0/0, tsc no new errors, vitest, vite build.
- Manual two-browser check for the live update path (documented, not
  automated: the harness cannot run two full clients against gossipsub in CI
  today).

## 9. Risks and open questions

- PluginUpdate as chat-class messages inflate room history (a busy poll =
  dozens of stored rows). Accepted for v1: reactions already behave this way.
  If it hurts, compaction is a later, isolated change.
- Ephemeral routing adds a message type to the presence switch: verified
  safe by review (participant lastSeen runs before the switch for all types,
  no default-case assumptions). Host-side flood cap: at most ~4 ephemerals
  per second per plugin per sender, excess dropped - a buggy plugin ticking
  every frame must not become a gossipsub flood.
- `content` holding JSON means old clients that DID know the type would show
  raw JSON: not a case that exists (new types), noted for future type reuse.
- Lamport tie-break must be deterministic (lamport, then message id) or two
  clients can fold updates in different orders. The fold sort is the single
  most correctness-critical line in the plan.

## 10. Review status

Reviewed adversarially against the codebase (fork with full session context).
Verdict: buildable with the fixes above, no redesign. Verified true: payload
in `content` inherits the v2 signature (messaging.ts canonicalContentV2);
glob paths resolve within the Vite root; no existing composer slash handling
to conflict with. The visibleMessages allowlist shipped ahead of this
surface.

## 11. Author documentation

The plugin author guide lives at `frontend/plugins/README.md`, next to the
plugins themselves. The plan (this file) is for the app's implementers; the
README is the contract plugin authors write against. Keep them in sync when
the API changes.
