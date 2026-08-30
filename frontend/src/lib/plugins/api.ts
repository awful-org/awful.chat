import type { Component } from "svelte";

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
}

export interface UpdateCtx {
  senderDid: string; // host-verified, never from payload
  senderName: string;
  updateId: string; // message id, stable across peers
  lamport: number;
  ephemeral: boolean;
}

export interface HostApi {
  // Built by GENERALIZING sendMessage, never as a parallel path: signing
  // (sigV2), lamport assignment (room counter vs wall-clock nextDmLamport
  // for dm- rooms), putMessage, setWatermark, appendSorted, markRoomSeen,
  // noteRoomActivity all live there, and parallel send paths are where this
  // codebase's historical bugs came from.
  sendCard(payload: unknown): Promise<string>; // returns cardId
  sendUpdate(
    cardId: string,
    payload: unknown,
    opts?: { ephemeral?: boolean }
  ): Promise<void>;
  roomCode(): string;
  selfDid(): string;
  peers(): Array<{ did: string; name: string }>;
  onPeerDisconnect(
    listener: (peer: { did: string; name: string }) => void
  ): () => void;
  onBeforeDisconnect(listener: () => void): () => void;
  sendUpdateImmediately(cardId: string, payload: unknown): void;
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
    } | null
  ): void;
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
  /** Is this peer reached through a relay rather than directly? */
  isRelayed(did: string): boolean;
  /** Show one session-only plugin surface in this room's conversation.
   *  It is never a Message: no signing, storage, sync, unread or notification. */
  showLocalCard(data?: unknown): string;
  closeLocalCard(id: string): void;
  /** Play a local audio blob through this user's outgoing call track. */
  callAudio: {
    blockedReason(): "not-in-call" | "deafened" | null;
    play(blob: Blob, options?: { volume?: number }): Promise<{ id: string; durationMs: number }>;
    stop(id?: string): void;
  };
  seededRandom(seed: string): () => number; // deterministic PRNG
  storage: {
    get(k: string): Promise<unknown>;
    set(k: string, v: unknown): Promise<void>;
  };
}

export interface PluginDefinition {
  manifest: PluginManifest;
  // Svelte component rendering a card. Props: { card, cardState, host }.
  // cardState, not state: a prop called `state` shadows the $state rune in
  // any card that uses runes, and the host has always passed this name.
  card?: PluginComponent;
  /** Private, session-only surface opened by HostApi.showLocalCard.
   * Props: { localCard, host, close }. It is not backed by a chat message. */
  localCard?: PluginComponent;
  /**
   * Compact view for a pinned sidebar widget box. Same props as `card`
   * ({ card, cardState, host }); when absent, pinning falls back to the
   * card component, so every plugin is pinnable with zero changes. Keep it
   * glanceable - the box is small and capped in height.
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
  callTileActive?: (cardState: unknown) => boolean;
  /**
   * Display names of the people currently using the tile (party members,
   * board editors), derived from state - PURE. The host shows them in the
   * same audience chip screen-share transmissions get.
   */
  callTileViewers?: (cardState: unknown) => string[];
  /**
   * Only ONE card of this plugin is ever worth pinning (a watch-together:
   * old parties are dead parties). The sidebar picker offers only the
   * newest card, and pinning it replaces any existing pin of this plugin.
   * Leave off for plugins where several cards coexist meaningfully (two
   * polls from different rooms).
   */
  singletonWidget?: boolean;
  /**
   * For singleton widgets: is this card currently YOURS, derived from its
   * reduced state - PURE (e.g. "am I a member of this party"). The pinned
   * strip follows the newest card for which this returns true, so ending
   * one party and joining another moves the widget with you; while no card
   * matches, the strip stays where it is. Absent, the strip follows the
   * plugin's newest card unconditionally.
   */
  widgetMine?: (cardState: unknown, selfDid: string) => boolean;
  // Pure reducer. Host feeds persisted updates in lamport order (history
  // replay first, then live), ephemeral updates live only.
  reduce?: (state: unknown, update: PluginUpdate, ctx: UpdateCtx) => unknown;
  /**
   * Build the starting state for one card. Receives the card's payload (the
   * object passed to host.sendCard) so options/questions seed the state -
   * without it a reducer bounds-checking against state saw empty data and
   * rejected every update.
   */
  initialState?: (cardData: unknown) => unknown;
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

export function definePlugin(def: PluginDefinition): PluginDefinition {
  return def;
}
