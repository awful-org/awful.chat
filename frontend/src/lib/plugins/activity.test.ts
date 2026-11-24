import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("./registry", () => ({ getPlugin: async () => null, getManifest: () => null }));

import { notifyIdentityLock } from "$lib/identity/lock-events";
import { openTile, ownActivities, setSelfActivity } from "./activity.svelte";
import { callTilesState, type PluginCallTile } from "./call-tiles.svelte";

const CALL = "rd2_call";
const OTHER = "rd2_other";
const tile = (over: Partial<PluginCallTile> = {}): PluginCallTile => ({
  pluginId: "waffle-party", cardId: "c", roomCode: CALL, viewers: [], ownActivity: "In Waffle Party", ...over,
});

afterEach(() => {
  notifyIdentityLock();
  callTilesState.tiles = [];
});

describe("what we are doing in the call's tiles", () => {
  it("is nothing of a tile we do not have open, whatever its card says of us", () => {
    // A card is other people's to write, and names us after we left.
    callTilesState.tiles = [tile()];
    expect(ownActivities(CALL)).toEqual([]);
    const close = openTile("waffle-party", CALL);
    expect(ownActivities(CALL)).toEqual([{ plugin: "waffle-party", label: "In Waffle Party" }]);
    close();
    expect(ownActivities(CALL)).toEqual([]);
  });

  it("is what the plugin says over what its state does, until the tile closes", () => {
    callTilesState.tiles = [tile()];
    const close = openTile("waffle-party", CALL);
    setSelfActivity("waffle-party", CALL, "Watching a film");
    expect(ownActivities(CALL)[0].label).toBe("Watching a film");
    setSelfActivity("waffle-party", CALL, null);
    expect(ownActivities(CALL)[0].label).toBe("In Waffle Party");
    setSelfActivity("waffle-party", CALL, "Watching a film");
    close();
    // Said after it closed, and kept from before: neither is there next time.
    setSelfActivity("waffle-party", CALL, "late");
    callTilesState.tiles = [tile({ ownActivity: undefined })];
    openTile("waffle-party", CALL);
    expect(ownActivities(CALL)).toEqual([]);
  });

  it("is the call's room's alone", () => {
    // A card or a widget of another room has no open tile to speak from.
    setSelfActivity("app", OTHER, "In an app");
    openTile("app", OTHER);
    setSelfActivity("app", OTHER, "In an app");
    expect(ownActivities(CALL)).toEqual([]);
    expect(ownActivities(OTHER)).toHaveLength(1);
    expect(ownActivities(null)).toEqual([]);
  });

  it("lasts while any view of the tile does, and no view closes twice", () => {
    const first = openTile("app", CALL);
    const second = openTile("app", CALL);
    setSelfActivity("app", CALL, "In an app");
    first();
    first();
    expect(ownActivities(CALL)).toHaveLength(1);
    second();
    expect(ownActivities(CALL)).toEqual([]);
  });

  it("goes with the session", () => {
    openTile("app", CALL);
    setSelfActivity("app", CALL, "In an app");
    notifyIdentityLock();
    expect(ownActivities(CALL)).toEqual([]);
  });
});
