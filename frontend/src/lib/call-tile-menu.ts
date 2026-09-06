/**
 * What the right-click menu of ONE call tile offers.
 *
 * Pure and unit-tested, for the same reason `call-tiles.ts` is: the rules
 * are "which controls does this stream have", not "how does a menu paint".
 * A right-click on a screen share, on your own camera, and on a plugin's
 * tile are three different questions, and before this module the stage
 * answered all three with one peer menu (message plus a volume slider) that
 * plugin and local tiles were excluded from outright - so right-clicking a
 * watch-together tile configured the whole grid instead.
 *
 * The rows carry an ACTION NAME, never a callback: the store calls live in
 * the stage, so this module stays free of transport, Svelte and the DOM.
 */

export type TileMenuKind = "camera" | "screen" | "transmission" | "plugin";

/** Icon keys the stage maps to lucide components. */
export type TileMenuIcon =
  | "pin"
  | "pin-off"
  | "pip"
  | "fullscreen"
  | "fullscreen-exit"
  | "message"
  | "watch"
  | "stop-watching"
  | "screen-off"
  | "camera"
  | "camera-off"
  | "mic"
  | "mic-off"
  | "volume"
  | "volume-off"
  | "join"
  | "leave"
  | "plugin";

export type TileMenuAction =
  /** Spotlight this tile / release the pin. */
  | { kind: "focus" }
  | { kind: "unfocus" }
  /** The browser's own floating window, following the pinned tile. */
  | { kind: "pip" }
  | { kind: "exit-pip" }
  | { kind: "fullscreen" }
  | { kind: "exit-fullscreen" }
  | { kind: "message" }
  /** Subscribe to an offered SFU share / drop the one being watched. */
  | { kind: "watch" }
  | { kind: "stop-watching" }
  | { kind: "stop-sharing" }
  | { kind: "toggle-camera" }
  | { kind: "toggle-mic" }
  /** Silence the share's own audio, not the sharer's voice. */
  | { kind: "mute-share" }
  | { kind: "unmute-share" }
  | { kind: "join-plugin" }
  | { kind: "leave-plugin" }
  /** Run the plugin's own item, by its index in `pluginItems`. */
  | { kind: "plugin"; index: number };

export type TileMenuRow =
  | { type: "label"; text: string }
  | { type: "separator" }
  | {
      type: "item";
      label: string;
      icon: TileMenuIcon;
      action: TileMenuAction;
      /** Rendered as a check mark, i.e. `role="menuitemcheckbox"`. */
      checked?: boolean;
      disabled?: boolean;
      /** Destructive: leaves, stops, hangs up. */
      danger?: boolean;
      /** A plugin's own emoji or "lucide:<name>" string. */
      pluginIcon?: string;
    }
  /** A slider, not an item: `peer` is a person's voice, `share` a share's audio. */
  | { type: "volume"; target: "peer" | "share" };

/**
 * One item a plugin declared for its own call tile. The host validates and
 * caps these (see PLUGIN_MENU_MAX_ITEMS) before they reach the builder, so
 * this module only positions them.
 */
export interface TileMenuPluginItem {
  label: string;
  /** Emoji, or "lucide:<kebab-name>" like a manifest icon. */
  icon?: string;
  checked?: boolean;
  disabled?: boolean;
  danger?: boolean;
}

/** Everything the menu needs to know about one tile, resolved by the stage. */
export interface TileMenuState {
  kind: TileMenuKind;
  /** Display name of the tile, already resolved (the peer, or the plugin). */
  label: string;
  isLocal: boolean;
  /** A video track is attached right now - what PiP needs to have something to float. */
  hasVideo: boolean;
  /** An SFU share offered to the room but not subscribed to. */
  isPending: boolean;
  /** This SFU share is the one being watched. */
  isWatched: boolean;
  /** This tile holds the spotlight. */
  isFocused: boolean;
  isFullscreen: boolean;
  pipSupported: boolean;
  /** The browser's PiP window is open. */
  pipOpen: boolean;
  /** A remote peer with a real peer id, so a DM can be opened. */
  canMessage: boolean;
  cameraOff: boolean;
  micMuted: boolean;
  /** The share carries audio at all. */
  shareAudio: boolean;
  /** Share audio is silenced (output volume 0). */
  shareMuted: boolean;
  /** Plugin tiles: has this user opted in. */
  joined: boolean;
  /** Plugin tiles: the plugin's own items, host-validated. */
  pluginItems: readonly TileMenuPluginItem[];
}

/** Defaults so a caller states only what its tile actually is. */
export function tileMenuState(
  partial: Partial<TileMenuState> & Pick<TileMenuState, "kind" | "label">
): TileMenuState {
  return {
    isLocal: false,
    hasVideo: false,
    isPending: false,
    isWatched: false,
    isFocused: false,
    isFullscreen: false,
    pipSupported: false,
    pipOpen: false,
    canMessage: false,
    cameraOff: false,
    micMuted: false,
    shareAudio: false,
    shareMuted: false,
    joined: false,
    pluginItems: [],
    ...partial,
  };
}

/** A plugin's tile menu is a short list of controls, not a second UI. */
export const PLUGIN_MENU_MAX_ITEMS = 8;
export const PLUGIN_MENU_MAX_LABEL = 40;

function focusRow(s: TileMenuState): TileMenuRow {
  return s.isFocused
    ? { type: "item", label: "Unfocus", icon: "pin-off", action: { kind: "unfocus" } }
    : { type: "item", label: "Focus", icon: "pin", action: { kind: "focus" } };
}

function pipRows(s: TileMenuState): TileMenuRow[] {
  // The host can only float a real video track. A plugin renders its own
  // media (and a cross-origin iframe cannot be floated by anyone but the
  // browser), so a plugin tile's PiP is the plugin's own menu item.
  if (!s.pipSupported || !s.hasVideo) return [];
  return s.pipOpen && s.isFocused
    ? [
        {
          type: "item",
          label: "Exit picture in picture",
          icon: "pip",
          action: { kind: "exit-pip" },
        },
      ]
    : [
        {
          type: "item",
          label: "Picture in picture",
          icon: "pip",
          action: { kind: "pip" },
        },
      ];
}

function fullscreenRow(s: TileMenuState): TileMenuRow {
  return s.isFullscreen
    ? {
        type: "item",
        label: "Exit fullscreen",
        icon: "fullscreen-exit",
        action: { kind: "exit-fullscreen" },
      }
    : {
        type: "item",
        label: "Fullscreen",
        icon: "fullscreen",
        action: { kind: "fullscreen" },
      };
}

function shareAudioRows(s: TileMenuState): TileMenuRow[] {
  if (!s.shareAudio) return [];
  return [
    s.shareMuted
      ? {
          type: "item",
          label: "Unmute share audio",
          icon: "volume",
          action: { kind: "unmute-share" },
        }
      : {
          type: "item",
          label: "Mute share audio",
          icon: "volume-off",
          action: { kind: "mute-share" },
        },
    { type: "volume", target: "share" },
  ];
}

function pluginRows(s: TileMenuState): TileMenuRow[] {
  return s.pluginItems.slice(0, PLUGIN_MENU_MAX_ITEMS).map((item, index) => ({
    type: "item" as const,
    label: item.label.slice(0, PLUGIN_MENU_MAX_LABEL),
    icon: "plugin" as const,
    pluginIcon: item.icon,
    action: { kind: "plugin" as const, index },
    checked: item.checked,
    disabled: item.disabled,
    danger: item.danger,
  }));
}

/**
 * The rows for one tile's context menu, top to bottom.
 *
 * Ordering rule: what this tile IS first (focus, float, fullscreen), then
 * who or what it belongs to (message the person, the plugin's own controls),
 * and the way out last (stop watching, stop sharing, leave) - so the
 * destructive row never lands where the previous menu's first item was.
 */
export function buildTileMenu(s: TileMenuState): TileMenuRow[] {
  const rows: TileMenuRow[] = [
    { type: "label", text: tileMenuTitle(s) },
  ];

  if (s.kind === "plugin") {
    if (!s.joined) {
      rows.push({
        type: "item",
        label: `Join ${s.label}`,
        icon: "join",
        action: { kind: "join-plugin" },
      });
      return rows;
    }
    rows.push(focusRow(s), fullscreenRow(s));
    const plugin = pluginRows(s);
    if (plugin.length) rows.push({ type: "separator" }, ...plugin);
    rows.push({ type: "separator" }, {
      type: "item",
      label: `Leave ${s.label}`,
      icon: "leave",
      action: { kind: "leave-plugin" },
      danger: true,
    });
    return rows;
  }

  // An offered share nobody subscribed to has one thing to offer.
  if (s.kind === "transmission" && s.isPending) {
    rows.push({
      type: "item",
      label: `Watch ${s.label}'s screen`,
      icon: "watch",
      action: { kind: "watch" },
    });
    return rows;
  }

  rows.push(focusRow(s), ...pipRows(s), fullscreenRow(s));

  if (s.kind === "camera" && s.isLocal) {
    rows.push(
      { type: "separator" },
      s.cameraOff
        ? {
            type: "item",
            label: "Turn on camera",
            icon: "camera",
            action: { kind: "toggle-camera" },
          }
        : {
            type: "item",
            label: "Turn off camera",
            icon: "camera-off",
            action: { kind: "toggle-camera" },
          },
      s.micMuted
        ? {
            type: "item",
            label: "Unmute microphone",
            icon: "mic",
            action: { kind: "toggle-mic" },
          }
        : {
            type: "item",
            label: "Mute microphone",
            icon: "mic-off",
            action: { kind: "toggle-mic" },
          }
    );
    return rows;
  }

  if (s.isLocal) {
    // Your own screen share: the only stream you can end for everyone.
    rows.push({ type: "separator" }, {
      type: "item",
      label: "Stop sharing",
      icon: "screen-off",
      action: { kind: "stop-sharing" },
      danger: true,
    });
    return rows;
  }

  const tail: TileMenuRow[] = [];
  if (s.kind === "camera") {
    if (s.canMessage) {
      tail.push({
        type: "item",
        label: "Message",
        icon: "message",
        action: { kind: "message" },
      });
    }
    // The per-person listening volume, the app's only real "mute them".
    tail.push({ type: "volume", target: "peer" });
  } else {
    tail.push(...shareAudioRows(s));
    if (s.isWatched) {
      tail.push({
        type: "item",
        label: "Stop watching",
        icon: "stop-watching",
        action: { kind: "stop-watching" },
        danger: true,
      });
    }
  }
  if (tail.length) rows.push({ type: "separator" }, ...tail);
  return rows;
}

/** The menu's heading: whose stream this is, in the words the tiles use. */
export function tileMenuTitle(s: TileMenuState): string {
  if (s.kind === "plugin") return s.label;
  if (s.kind === "screen" || s.kind === "transmission") {
    return s.isLocal ? "Your screen" : `${s.label}'s screen`;
  }
  return s.isLocal ? `${s.label} (You)` : s.label;
}

/**
 * How tall the menu will be, for the viewport clamp.
 *
 * Estimated from the row classes rather than measured: the menu is
 * positioned in the same frame the right-click arrives in, and a measured
 * height would need a paint first (which is the jump this avoids). The
 * numbers are the rendered heights of the rows in the stage.
 */
export function tileMenuHeight(rows: readonly TileMenuRow[]): number {
  let height = 8; // py-1 on the menu itself
  for (const row of rows) {
    if (row.type === "item") height += 32;
    else if (row.type === "label") height += 22;
    else if (row.type === "separator") height += 9;
    else height += 62;
  }
  return height;
}
