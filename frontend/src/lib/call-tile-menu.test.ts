import { describe, it, expect } from "vitest";
import {
  buildTileMenu,
  tileMenuHeight,
  tileMenuState,
  tileMenuTitle,
  PLUGIN_MENU_MAX_ITEMS,
  type TileMenuAction,
  type TileMenuRow,
} from "./call-tile-menu";

/** The action names of a menu, in order - what a click can actually do. */
function actions(rows: TileMenuRow[]): TileMenuAction["kind"][] {
  return rows
    .filter((r) => r.type === "item")
    .map((r) => (r as { action: TileMenuAction }).action.kind);
}

function labels(rows: TileMenuRow[]): string[] {
  return rows
    .filter((r) => r.type === "item")
    .map((r) => (r as { label: string }).label);
}

describe("buildTileMenu", () => {
  it("offers a remote camera the person, not the stream", () => {
    const rows = buildTileMenu(
      tileMenuState({
        kind: "camera",
        label: "Ada",
        hasVideo: true,
        pipSupported: true,
        canMessage: true,
      })
    );
    expect(actions(rows)).toEqual(["focus", "pip", "fullscreen", "message"]);
    // The per-peer slider is the app's only real per-person mute.
    expect(rows).toContainEqual({ type: "volume", target: "peer" });
    expect(rows[0]).toEqual({ type: "label", text: "Ada" });
  });

  it("drops Message for a peer with no DM route", () => {
    const rows = buildTileMenu(
      tileMenuState({ kind: "camera", label: "Ada", canMessage: false })
    );
    expect(actions(rows)).not.toContain("message");
    expect(rows).toContainEqual({ type: "volume", target: "peer" });
  });

  it("gives the local camera its own devices and never a volume slider", () => {
    const rows = buildTileMenu(
      tileMenuState({
        kind: "camera",
        label: "You",
        isLocal: true,
        hasVideo: true,
        pipSupported: true,
        cameraOff: false,
        micMuted: true,
      })
    );
    expect(actions(rows)).toEqual([
      "focus",
      "pip",
      "fullscreen",
      "toggle-camera",
      "toggle-mic",
    ]);
    expect(labels(rows)).toContain("Turn off camera");
    expect(labels(rows)).toContain("Unmute microphone");
    expect(rows.some((r) => r.type === "volume")).toBe(false);
  });

  it("labels the local camera toggles by the state they move to", () => {
    const rows = buildTileMenu(
      tileMenuState({
        kind: "camera",
        label: "You",
        isLocal: true,
        cameraOff: true,
        micMuted: false,
      })
    );
    expect(labels(rows)).toContain("Turn on camera");
    expect(labels(rows)).toContain("Mute microphone");
  });

  it("lets you end only your OWN share", () => {
    const mine = buildTileMenu(
      tileMenuState({
        kind: "screen",
        label: "You",
        isLocal: true,
        hasVideo: true,
        pipSupported: true,
      })
    );
    expect(actions(mine)).toEqual(["focus", "pip", "fullscreen", "stop-sharing"]);
    expect(mine.find((r) => r.type === "label")).toEqual({
      type: "label",
      text: "Your screen",
    });

    const theirs = buildTileMenu(
      tileMenuState({ kind: "screen", label: "Ada", hasVideo: true })
    );
    expect(actions(theirs)).not.toContain("stop-sharing");
  });

  it("offers a watched share its audio and the way out", () => {
    const rows = buildTileMenu(
      tileMenuState({
        kind: "transmission",
        label: "Ada",
        hasVideo: true,
        isWatched: true,
        pipSupported: true,
        shareAudio: true,
      })
    );
    expect(actions(rows)).toEqual([
      "focus",
      "pip",
      "fullscreen",
      "mute-share",
      "stop-watching",
    ]);
    expect(rows).toContainEqual({ type: "volume", target: "share" });
    // Stop watching is destructive and must be last, never where Focus was.
    const last = rows[rows.length - 1];
    expect(last).toMatchObject({ danger: true, label: "Stop watching" });
  });

  it("flips the share-audio item once it is silenced", () => {
    const rows = buildTileMenu(
      tileMenuState({
        kind: "transmission",
        label: "Ada",
        isWatched: true,
        shareAudio: true,
        shareMuted: true,
      })
    );
    expect(actions(rows)).toContain("unmute-share");
    expect(actions(rows)).not.toContain("mute-share");
  });

  it("hides share-audio rows when the share carries no audio", () => {
    const rows = buildTileMenu(
      tileMenuState({
        kind: "transmission",
        label: "Ada",
        isWatched: true,
        shareAudio: false,
      })
    );
    expect(actions(rows)).not.toContain("mute-share");
    expect(rows.some((r) => r.type === "volume")).toBe(false);
  });

  it("reduces an offered share to the one thing it can do", () => {
    const rows = buildTileMenu(
      tileMenuState({ kind: "transmission", label: "Ada", isPending: true })
    );
    expect(actions(rows)).toEqual(["watch"]);
    expect(labels(rows)).toEqual(["Watch Ada's screen"]);
  });

  it("keeps picture-in-picture off a tile with no track to float", () => {
    const noTrack = buildTileMenu(
      tileMenuState({ kind: "camera", label: "Ada", pipSupported: true })
    );
    expect(actions(noTrack)).not.toContain("pip");

    const noSupport = buildTileMenu(
      tileMenuState({ kind: "camera", label: "Ada", hasVideo: true })
    );
    expect(actions(noSupport)).not.toContain("pip");
  });

  it("offers to leave picture-in-picture only for the tile that is floating", () => {
    const floating = buildTileMenu(
      tileMenuState({
        kind: "screen",
        label: "Ada",
        hasVideo: true,
        pipSupported: true,
        pipOpen: true,
        isFocused: true,
      })
    );
    expect(actions(floating)).toContain("exit-pip");

    const other = buildTileMenu(
      tileMenuState({
        kind: "screen",
        label: "Ada",
        hasVideo: true,
        pipSupported: true,
        pipOpen: true,
        isFocused: false,
      })
    );
    expect(actions(other)).toContain("pip");
    expect(actions(other)).not.toContain("exit-pip");
  });

  it("mirrors focus and fullscreen state in the labels", () => {
    const rows = buildTileMenu(
      tileMenuState({
        kind: "camera",
        label: "Ada",
        isFocused: true,
        isFullscreen: true,
      })
    );
    expect(actions(rows)).toContain("unfocus");
    expect(actions(rows)).toContain("exit-fullscreen");
    expect(actions(rows)).not.toContain("focus");
  });

  it("asks an unjoined plugin tile for nothing but consent", () => {
    const rows = buildTileMenu(
      tileMenuState({
        kind: "plugin",
        label: "Waffle party",
        pluginItems: [{ label: "Pause" }],
      })
    );
    // Opt-in is the invariant: no plugin item runs before the user joins.
    expect(actions(rows)).toEqual(["join-plugin"]);
    expect(labels(rows)).toEqual(["Join Waffle party"]);
  });

  it("puts a joined plugin's own items between the host's rows", () => {
    const rows = buildTileMenu(
      tileMenuState({
        kind: "plugin",
        label: "Waffle party",
        joined: true,
        pluginItems: [
          { label: "Picture in picture" },
          { label: "Mute", checked: true },
          { label: "Skip", disabled: true },
        ],
      })
    );
    expect(actions(rows)).toEqual([
      "focus",
      "fullscreen",
      "plugin",
      "plugin",
      "plugin",
      "leave-plugin",
    ]);
    expect(labels(rows)).toEqual([
      "Focus",
      "Fullscreen",
      "Picture in picture",
      "Mute",
      "Skip",
      "Leave Waffle party",
    ]);
    const items = rows.filter((r) => r.type === "item") as Array<{
      action: TileMenuAction;
      checked?: boolean;
      disabled?: boolean;
    }>;
    // Indices address the plugin's own array, in its own order.
    expect(items[2].action).toEqual({ kind: "plugin", index: 0 });
    expect(items[3]).toMatchObject({ checked: true });
    expect(items[4]).toMatchObject({ disabled: true });
  });

  it("never offers host picture-in-picture on a plugin tile", () => {
    const rows = buildTileMenu(
      tileMenuState({
        kind: "plugin",
        label: "Waffle party",
        joined: true,
        // A plugin tile has no track; even claiming one must not add the row,
        // because the host cannot float media it does not render.
        hasVideo: true,
        pipSupported: true,
      })
    );
    expect(actions(rows)).not.toContain("pip");
  });

  it("caps and trims what a plugin may put in the menu", () => {
    const rows = buildTileMenu(
      tileMenuState({
        kind: "plugin",
        label: "Loud plugin",
        joined: true,
        pluginItems: Array.from({ length: 40 }, (_, i) => ({
          label: `${"x".repeat(200)}${i}`,
        })),
      })
    );
    const pluginItems = rows.filter(
      (r) => r.type === "item" && r.action.kind === "plugin"
    ) as Array<{ label: string }>;
    expect(pluginItems).toHaveLength(PLUGIN_MENU_MAX_ITEMS);
    for (const item of pluginItems) expect(item.label.length).toBeLessThanOrEqual(40);
    // The host's own way out survives a flood.
    expect(actions(rows).at(-1)).toBe("leave-plugin");
  });

  it("has a heading and no double separators for every kind", () => {
    const kinds = ["camera", "screen", "transmission", "plugin"] as const;
    for (const kind of kinds) {
      for (const isLocal of [false, true]) {
        const rows = buildTileMenu(
          tileMenuState({ kind, label: "Ada", isLocal, joined: true })
        );
        expect(rows[0].type).toBe("label");
        expect(rows.at(-1)!.type).not.toBe("separator");
        rows.forEach((row, i) => {
          if (row.type === "separator") {
            expect(rows[i + 1]?.type).not.toBe("separator");
          }
        });
      }
    }
  });
});

describe("tileMenuTitle", () => {
  it("names a share by its owner", () => {
    expect(
      tileMenuTitle(tileMenuState({ kind: "transmission", label: "Ada" }))
    ).toBe("Ada's screen");
    expect(
      tileMenuTitle(
        tileMenuState({ kind: "screen", label: "Me", isLocal: true })
      )
    ).toBe("Your screen");
  });

  it("marks your own camera the way the tile badge does", () => {
    expect(
      tileMenuTitle(
        tileMenuState({ kind: "camera", label: "Ada", isLocal: true })
      )
    ).toBe("Ada (You)");
  });
});

describe("tileMenuHeight", () => {
  it("grows with the rows so the clamp keeps a long menu on screen", () => {
    const short = buildTileMenu(
      tileMenuState({ kind: "transmission", label: "Ada", isPending: true })
    );
    const long = buildTileMenu(
      tileMenuState({
        kind: "plugin",
        label: "Waffle party",
        joined: true,
        pluginItems: Array.from({ length: 8 }, (_, i) => ({ label: `i${i}` })),
      })
    );
    expect(tileMenuHeight(short)).toBeLessThan(tileMenuHeight(long));
    expect(tileMenuHeight([])).toBeGreaterThan(0);
  });
});
