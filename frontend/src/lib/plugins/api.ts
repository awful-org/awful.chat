import type { Component } from "svelte";
import { apiUrl } from "$lib/runtime-config";
import type { Message } from "$lib/types/message";
import type { LocalPluginCardEntry } from "./local-cards.svelte";

/**
 * A component the host renders on a plugin's behalf.
 *
 * Props are permissive on purpose. The host's side of the contract is
 * fixed - card, cardState, host - but cardState is a different shape for
 * every plugin, and bare `Component` means `Component<{}>`, which a
 * component that declares any props at all cannot satisfy. Naming the type
 * once keeps that reasoning in one place instead of a cast at each surface
 * that renders one.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type PluginComponent = Component<any>;

export interface PluginManifest {
  id: string; // ^[a-z0-9-]{2,32}$, folder name must match
  name: string;
  description: string;
  /** Shown in the plugins settings list. */
  author?: string;
  /** SPDX-ish string, e.g. "MIT". Shown next to the author. */
  license?: string; // one line, shown in settings
  /** Shown on the card header and in settings, e.g. "1.2.0". */
  version?: string;
  /** https URL of the plugin's source repository. Linked from the card
   *  header and the settings list. */
  repository?: string;
  /** An emoji, or a lucide icon as "lucide:<kebab-name>" (e.g. "lucide:dices"). */
  icon: string;
  apiVersion: 1;
  /**
   * Slash commands this plugin offers, for the composer's "/" popup. Lives
   * in the manifest because the popup must list commands WITHOUT loading
   * plugin code. Names must match the keys of the definition's `commands`.
   */
  commands?: Array<{ name: string; usage: string }>;
  /** This plugin ships a `settings` component; draws the gear in the
   *  plugins tab without loading plugin code. */
  hasSettings?: boolean;
  /**
   * Host features this plugin cannot run without, from HOST_FEATURES. A
   * host that does not know one of them refuses to LOAD the plugin and
   * says so, instead of mounting code that crashes on a missing API - the
   * graceful path for a plugin newer than the app running it.
   */
  requires?: string[];
}

/**
 * Every capability this host build can satisfy in a manifest's `requires`.
 * Grows a name per new host API; old builds simply not containing a name
 * is exactly what makes the gate work.
 */
export const HOST_FEATURES: ReadonlySet<string> = new Set([
  "room-context",
  "resolve-room-image",
  "open-message",
  "call-audio",
  "call-capture",
  "clock-sample",
  "local-card",
  "now-playing",
  "confirm",
  "plugin-settings",
  "plugin-stream",
  "picture-in-picture",
  "call-tile-menu",
]);

export interface UpdateCtx {
  senderDid: string; // host-verified, never from payload
  senderName: string;
  updateId: string; // message id, stable across peers
  lamport: number;
  ephemeral: boolean;
}

/**
 * What the host knows about a card that its payload cannot claim.
 *
 * `senderDid` is the signed message's sender, so it is the ONLY trustworthy
 * answer to "who posted this card". A payload field naming an owner is
 * peer-supplied: anyone in the room can send a card claiming any DID.
 */
export interface CardCtx {
  senderDid: string; // host-verified, never from payload
}

export interface HostApi {
  // Built by GENERALIZING sendMessage, never as a parallel path: signing
  // (sigV2), lamport assignment (room counter vs wall-clock nextDmLamport
  // for dm- rooms), putMessage, setWatermark, appendSorted, markRoomSeen,
  // noteRoomActivity all live there, and parallel send paths are where this
  // codebase's historical bugs came from.
  /**
   * Post a card to the host's room. `payload` is what `initialState`
   * receives on every client, so seed options and questions from it; it is
   * JSON, capped at 16 KB. Resolves to the card's id, which updates name.
   */
  sendCard(payload: unknown): Promise<string>;
  /**
   * Attach an update to a card. Persisted and replayed in fold order
   * (lamport, senderId, updateId) on every client, into your `reduce`.
   * `{ ephemeral: true }` sends live only, never stored or replayed
   * (cursors, ticks), capped at about four a second per sender. JSON,
   * 4 KB; anything larger is refused.
   */
  sendUpdate(
    cardId: string,
    payload: unknown,
    opts?: { ephemeral?: boolean }
  ): Promise<void>;
  /** The room this host is bound to. "" on the settings surface. */
  roomCode(): string;
  /** This user's DID, the same value `ctx.senderDid` carries for their own updates. */
  selfDid(): string;
  /** Peers connected right now, with the display names the host knows. */
  peers(): Array<{ did: string; name: string }>;
  /** A peer left. Returns unsubscribe; call it when your surface unmounts. */
  onPeerDisconnect(
    listener: (peer: { did: string; name: string }) => void
  ): () => void;
  /**
   * This page is going away (close, reload, navigation). Synchronous work
   * only: send a departure beacon with `sendUpdateImmediately`. Returns
   * unsubscribe.
   */
  onBeforeDisconnect(listener: () => void): () => void;
  /**
   * The teardown-safe `sendUpdate`: no async work, same room binding, for
   * the `onBeforeDisconnect` beacon. Fire and forget.
   */
  sendUpdateImmediately(cardId: string, payload: unknown): void;
  /**
   * This plugin's existing cards in the host's room, newest last. Cheap: it
   * reads card rows only, and `state` is the folded state when the host has
   * it in memory.
   */
  cards(): Promise<Array<{ id: string; senderDid: string; state?: unknown }>>;
  /** Notify card surfaces after a persisted plugin state fold. */
  onCardStateChange(listener: () => void): () => void;
  /**
   * Put the plugin's playback on the OS media surface (lock screen, media
   * keys, headsets). The host owns navigator.mediaSession and arbitrates:
   * the latest claimer wins, and null releases only your own claim. Call
   * from the surface that RENDERS the playback, clear on unmount. The
   * handlers should fire your SYNCED actions - a lock-screen pause pauses
   * the party for everyone, like the in-tile controls.
   */
  setNowPlaying(
    info: {
      title: string;
      artist?: string;
      artworkUrl?: string;
      playing: boolean;
      onPlay?: () => void;
      onPause?: () => void;
      onNext?: () => void;
      onPrevious?: () => void;
      /**
       * The element to float when the browser enters picture-in-picture on
       * its own (Chromium pops the window on a tab switch while media
       * plays). A call in progress keeps its spotlight as the target.
       */
      pipVideo?: HTMLVideoElement;
    } | null
  ): void;
  /**
   * Float this video in the browser's own picture-in-picture window, the
   * one that survives a tab switch and, on a phone, leaving the app. Call
   * it from a click: browsers refuse it without a gesture. Resolves false
   * where the platform has no API (Firefox has only its hover toggle) or
   * the browser refused. Only for media the plugin renders itself: a video
   * inside a cross-origin iframe can be floated by nobody but the browser.
   */
  pictureInPicture(video: HTMLVideoElement): Promise<boolean>;
  /**
   * One round-trip probe to a peer, in milliseconds, or null if it did not
   * answer in time.
   *
   * The host owns this because plugins have no peer-addressed channel at
   * all - sendCard and sendUpdate are room broadcasts through the signed
   * pipeline, and timing one of those would measure signing, fan-out and
   * the reducer rather than the link. The probe is answered on the peer's
   * receive path before any of that, so it measures the connection.
   *
   * One probe, not a schedule: the cadence, the window and what to do with
   * the numbers belong to whoever is asking.
   */
  ping(did: string, opts?: { timeoutMs?: number }): Promise<number | null>;
  /**
   * One NTP-style clock probe against a peer: the four timestamps
   * `estimateClock` in $lib/plugins/watch folds into an offset (t1 equals
   * t2 - the peer answers inline). Null is loss, or a peer running a build
   * whose probes carry no clock. Like ping, it is one sample, not a
   * schedule: take several and median-filter via estimateClock.
   */
  clockSample(
    did: string,
    opts?: { timeoutMs?: number }
  ): Promise<{ t0: number; t1: number; t2: number; t3: number } | null>;
  /** Is this peer reached through a relay rather than directly? */
  isRelayed(did: string): boolean;
  /**
   * Recent HUMAN conversation of this host's room, bounded and sanitized:
   * text, replies, file captions, image METADATA. Never plugin cards or
   * updates, never system rows, never another room, and never more than the
   * host's caps (see $lib/plugins/room-context) regardless of `limit`.
   * Ascending order; `limit` counts kept messages, newest-first.
   */
  roomContext(options?: {
    limit?: number;
  }): Promise<import("./room-context").RoomContextMessage[]>;
  /**
   * Resolve an image reference from roomContext() into a displayable Blob,
   * through the host's normal attachment path (stored bytes, a live
   * transfer, or a fresh download from whoever seeds it). Null when the
   * bytes cannot be produced - not stored, nobody seeding, not an image,
   * or the hash does not belong to this room.
   */
  resolveRoomImage(
    infoHash: string,
    options?: { timeoutMs?: number }
  ): Promise<Blob | null>;
  /**
   * Scroll the conversation to a message of this room and flash it - the
   * "view evidence" affordance. Resolves false when the message does not
   * exist or belongs to another room.
   */
  openMessage(messageId: string): Promise<boolean>;
  /**
   * Ask THIS user a yes/no question in host-drawn chrome (plugin name and
   * icon shown by the host, content by the caller). Resolves the choice;
   * declines on dismissal. The host queues one dialog at a time and allows
   * one PENDING request per plugin - a second while one waits resolves
   * false immediately, so a plugin cannot stack popups. Built for consent
   * flows: a peer's plugin asks over plugin updates, the local plugin
   * relays the question here, and only the answer travels back.
   */
  confirm(options: {
    title: string;
    message: string;
    acceptLabel?: string;
    declineLabel?: string;
    /**
     * Give up after this long (clamped 1s..10min) and resolve "timeout".
     * Without it the promise waits for as long as the user ignores it -
     * which for a group consent flow means one silent person stalls the
     * asker forever.
     */
    timeoutMs?: number;
    /** Withdraw the question when it stops applying (the asker left, the
     *  recording already ended): the dialog closes and it resolves
     *  "withdrawn". */
    signal?: AbortSignal;
    /**
     * The PEER this question is on behalf of. The host resolves it to a
     * name against the room's own peers and renders that in ITS chrome -
     * so "Bob wants to record" is a fact the host vouches for, not a
     * string the plugin can forge. Unknown DIDs are simply not shown.
     */
    fromDid?: string;
  }): Promise<import("./confirm.svelte").PluginConfirmResult>;
  /** Show one session-only plugin surface in this room's conversation.
   *  It is never a Message: no signing, storage, sync, unread or notification. */
  showLocalCard(data?: unknown): string;
  /** Close a local card by the id `showLocalCard` returned. */
  closeLocalCard(id: string): void;
  /** Play a local audio blob through this user's outgoing call track.
   *  Sounds are scoped to the calling plugin: several of this plugin's clips
   *  can layer (the host caps concurrency and evicts the oldest), and stop()
   *  never touches another plugin's audio. */
  callAudio: {
    blockedReason(): "not-in-call" | "deafened" | null;
    /** Host policy ceiling for a decoded clip - validate against this
     *  instead of hardcoding the number. */
    maxDurationMs: number;
    play(blob: Blob, options?: { volume?: number }): Promise<{ id: string; durationMs: number }>;
    /** Stop one of this plugin's sounds by id, or all of them with no id. */
    stop(id?: string): void;
  };
  /** Tap the call's audio locally - a recorder or transcriber captures what
   *  this client already renders or transmits. Nothing leaves the device
   *  through this API. */
  callCapture: {
    blockedReason(): "not-in-call" | null;
    /** Snapshot: one entry per audible participant, self included. "self"
     *  is the OUTGOING stream (post noise suppression, call sounds
     *  included) - exactly what peers hear, so mute captures silence.
     *  Every stream is a CLONE the plugin owns: stop its tracks when done,
     *  and take a fresh snapshot on change. */
    streams(): {
      id: string;
      name: string;
      self: boolean;
      stream: MediaStream;
    }[];
    /** Fires when the set of audible participants changes. Returns
     *  unsubscribe - call it when your surface unmounts. */
    onChange(cb: () => void): () => void;
  };
  /**
   * A deterministic PRNG for `seed`: the same seed gives the same sequence
   * on every client, which is how an outcome peers must agree on is drawn.
   * Seed it from ids the host verified (`ctx.updateId`, `ctx.senderDid`),
   * never from the clock or Math.random.
   */
  seededRandom(seed: string): () => number;
  /**
   * Device-local key-value store, namespaced per plugin (not per room:
   * prefix keys with `roomCode()` for that). JSON in localStorage, so keep
   * values small; a blocked or full store fails silently and `get` returns
   * undefined. Nothing here syncs anywhere.
   */
  storage: {
    get(k: string): Promise<unknown>;
    set(k: string, v: unknown): Promise<void>;
  };
}

// ── Surface props ───────────────────────────────────────────────────────────
//
// What the host passes to each component on a definition, named here so a
// plugin types its props from the API alone and never reaches into the app.

/** The chat message a card lives in, exactly as the host passes it. */
export type CardMessage = Message;

/** Props of the `card` surface. */
export interface CardProps<State = unknown> {
  card: CardMessage;
  cardState: State;
  host: HostApi;
}

/**
 * Props of the `widget` surface. `card` is null and `cardState` undefined
 * for a plugin with no card surface at all, and while no card of yours is
 * current (see `widgetMine`).
 */
export interface WidgetProps<State = unknown> {
  card: CardMessage | null;
  cardState: State | undefined;
  host: HostApi;
}

/**
 * Props of the `callTile` surface: the card's, plus whether the call's own
 * controls are showing, so your overlays move with them.
 */
export interface CallTileProps<State = unknown> extends CardProps<State> {
  chromeVisible: boolean;
}

/**
 * One entry a plugin adds to its call tile's right-click menu.
 *
 * The host draws it in ITS menu chrome, beside the rows every tile has
 * (focus, fullscreen, leave), so a watch-together tile offers "Picture in
 * picture" and "Mute" in the same place a screen share offers them.
 *
 * `run` is called on the click, on the client that clicked: use it for the
 * local surface (float the video, mute this device) or for a SYNCED action
 * through `sendUpdate`, exactly as an in-tile button would. The host caps
 * the list at eight items and trims labels to 40 characters, and an item
 * that throws is logged, never fatal.
 */
export interface CallTileMenuItem {
  /** Stable across rebuilds; the host keys the row on it. */
  id: string;
  label: string;
  /** An emoji, or a lucide icon as "lucide:<kebab-name>". */
  icon?: string;
  /** Draws a check mark - for a toggle whose state you already know. */
  checked?: boolean;
  disabled?: boolean;
  /** Destructive, drawn in the host's danger colour. */
  danger?: boolean;
  run(): void | Promise<void>;
}

/**
 * What `callTileMenu` is given: the same card, state and host the tile
 * itself has, plus whether this user has joined the tile.
 */
export interface CallTileMenuCtx<State = unknown> {
  card: CardMessage;
  cardState: State;
  host: HostApi;
  /** The tile is only asked for items once joined, so this is always true
   *  today - it exists so an unjoined menu can grow items without a
   *  signature change. */
  joined: boolean;
}

/** Props of the `localCard` surface. `localCard.data` is what `showLocalCard` was given. */
export interface LocalCardProps {
  localCard: LocalPluginCardEntry;
  host: HostApi;
  close: () => void;
}

/** Props of the `settings` surface. The host is bound to no room here. */
export interface SettingsProps {
  host: HostApi;
}

/**
 * A plugin. `State` is the shape your reducer keeps per card and `CardData`
 * the payload `sendCard` is given; `definePlugin` infers both from
 * `initialState`, so `reduce` and the surface predicates see your own types.
 */
export interface PluginDefinition<State = unknown, CardData = unknown> {
  manifest: PluginManifest;
  /**
   * Svelte component rendering a card. Props: `CardProps<State>`, that is
   * `{ card, cardState, host }`. cardState, not state: a prop called
   * `state` shadows the $state rune in any card that uses runes, and the
   * host has always passed this name.
   */
  card?: PluginComponent;
  /** Private, session-only surface opened by HostApi.showLocalCard.
   * Props: { localCard, host, close }. It is not backed by a chat message. */
  localCard?: PluginComponent;
  /**
   * Settings UI, opened from the gear on this plugin's row in the plugins
   * tab. Props: { host } - no card, no room (the host's roomCode is "").
   * Announce it via manifest.hasSettings so the gear renders without
   * loading plugin code.
   */
  settings?: PluginComponent;
  /**
   * Compact view for a pinned sidebar widget box. Pins name the PLUGIN, not
   * a card: the box resolves the current subject live - the newest card
   * widgetMine claims, else the plugin's newest card - so the strip follows
   * you between parties. Props are { card, cardState, host }; for a plugin
   * with no `card` surface at all (a device-local soundboard) the widget
   * mounts with card: null and cardState: undefined. Keep it glanceable -
   * the box is small and capped in height.
   */
  widget?: PluginComponent;
  /**
   * A tile in the call grid - the plugin appears as a "streamer" (a YouTube
   * watch-together, a shared board) rather than a chat card. Same props as
   * `card`. The tile is CLICK-TO-JOIN like screen shares: render nothing
   * loud until the user opted in. Content renders locally on every client;
   * only plugin state syncs, so this costs the SFU nothing.
   */
  callTile?: PluginComponent;
  /**
   * Whether a card should currently occupy a call tile, derived from its
   * reduced state - PURE and deterministic, so every client shows and hides
   * the tile in the same fold. Absent means "always on while the card
   * exists", which is almost never what you want.
   */
  callTileActive?(cardState: State): boolean;
  /**
   * Display names of the people currently using the tile (party members,
   * board editors), derived from state - PURE. The host shows them in the
   * same audience chip screen-share transmissions get.
   */
  callTileViewers?(cardState: State): string[];
  /**
   * Extra rows for the tile's right-click menu, built on demand when the
   * user opens it - so this one is NOT pure: read whatever the controls need
   * and close over the host. It is asked per right-click, never cached.
   *
   * Put here what the tile's own overlay has no room for, and what a viewer
   * expects a stream to offer: float this video (`host.pictureInPicture`),
   * mute it on this device, skip, stop. Say in the label which side the
   * action lands on - "Mute for me" is local, "Pause" pauses the party for
   * everyone.
   */
  callTileMenu?(ctx: CallTileMenuCtx<State>): CallTileMenuItem[];
  /**
   * @deprecated Pins are one-per-plugin by construction now (a pin names
   * the plugin, not a card), which is all this flag ever bought. Accepted
   * and ignored so existing definitions keep compiling.
   */
  singletonWidget?: boolean;
  /**
   * Is this card currently YOURS, derived from its reduced state - PURE
   * (e.g. "am I a member of this party"). The pinned strip follows the
   * newest card for which this returns true, so ending one party and
   * joining another moves the widget with you; while no card matches, the
   * strip shows the plugin's newest card, so a party you have not joined
   * is still one click away. Absent, the strip follows the newest card
   * unconditionally.
   */
  widgetMine?(cardState: State, selfDid: string): boolean;
  /**
   * Pure reducer. The host feeds persisted updates in fold order (history
   * replay first, then live) and ephemeral updates live only. Return the
   * same state to reject an update. `update.data` is peer-supplied and
   * untrusted; validate it like network input.
   *
   * Method syntax on purpose: it keeps a definition typed with your State
   * assignable to the host's `PluginDefinition<unknown>`.
   */
  reduce?(state: State, update: PluginUpdate, ctx: UpdateCtx): State;
  /**
   * Build the starting state for one card. Receives the card's payload (the
   * object passed to host.sendCard) so options/questions seed the state -
   * without it a reducer bounds-checking against state saw empty data and
   * rejected every update.
   *
   * `ctx.senderDid` is the card's host-verified sender. Anything that decides
   * who may write the card must come from there, NEVER from `cardData`: the
   * payload is peer-supplied, so an `ownerDid` in it is a claim, not a fact.
   * Second argument, so a plugin that only needs the payload keeps working.
   */
  initialState?(cardData: CardData, ctx: CardCtx): State;
  commands?: Record<
    string,
    (args: string, host: HostApi) => void | Promise<void>
  >;
}

// Internal message format: JSON stringified into content field
export interface PluginCardPayload {
  pluginId: string;
  data: unknown;
}

export interface PluginUpdatePayload {
  pluginId: string;
  cardId: string;
  data: unknown;
}

export interface PluginEphemeralPayload {
  pluginId: string;
  cardId: string;
  data: unknown;
}

export interface PluginUpdate {
  data: unknown;
}

/**
 * The instance's plugin proxy, for an upstream a browser cannot reach on its
 * own - no CORS, or it needs a secret the server holds.
 *
 * Exported here, as a FUNCTION, because the alternative is what actually
 * happened: a plugin wrote its own base from `import.meta.env.VITE_API_URL`,
 * vite replaced that with the literal value, and one line in one plugin put
 * the instance's own address back into a bundle that the whole
 * verify-what-an-instance-serves story needs to be identical everywhere. It
 * was found by fingerprinting a real deploy and diffing it against a local
 * build of the same commit.
 *
 * There is nothing to inline now even if somebody tries: the api origin is
 * read from /config.json after the app loads, so it has to be asked for at
 * the moment it is used. Call this per request, do not hoist it into a
 * module-level const.
 */
export function proxyUrl(upstream: string): string {
  return `${apiUrl()}/plugin-proxy?url=${encodeURIComponent(upstream)}`;
}

/**
 * The instance's STREAMING proxy, for media a browser cannot fetch itself:
 * an HLS playlist and its segments on a CDN that pins CORS to its own
 * origin. Same allowlist as `proxyUrl`, but the body is streamed rather than
 * buffered, `Range` is passed through in both directions, and the relay keeps
 * no copy, so the upstream's own caching headers are what a browser sees.
 *
 * Not a general replacement for `proxyUrl`: no `{{secret:NAME}}` is
 * substituted here (a player follows playlist-relative urls of its own, which
 * would carry the key onward), and there is no response cache.
 *
 * Read at call time for the same reason `proxyUrl` is, see above.
 */
export function streamUrl(upstream: string): string {
  return `${apiUrl()}/plugin-stream?url=${encodeURIComponent(upstream)}`;
}

/**
 * Identity at runtime; at type level it infers `State` (and `CardData`)
 * from `initialState`, so annotate that return and the rest follows.
 */
export function definePlugin<State = unknown, CardData = unknown>(
  def: PluginDefinition<State, CardData>
): PluginDefinition<State, CardData> {
  return def;
}
