import { afterEach, describe, expect, it, vi } from "vitest";
import { hashRef } from "./storage-crypto";

// What is on disk from before the original chat had a mode of its own, read
// back by a fresh load of the module.

const ROOM_KEY = "awful:room-notify:v1";
const CHANNEL_KEY = "awful:channel-notify:v1";

async function load(saved: Record<string, unknown>) {
  const disk = new Map(Object.entries(saved).map(([k, v]) => [k, JSON.stringify(v)]));
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => disk.get(k) ?? null,
    setItem: (k: string, v: string) => void disk.set(k, v),
  });
  vi.resetModules();
  return { prefs: await import("./notify-prefs.svelte"), disk };
}

afterEach(() => vi.unstubAllGlobals());

describe("modes saved before the original chat had its own", () => {
  it("leave a muted room a muted room, and its original chat following it", async () => {
    const { prefs } = await load({ [ROOM_KEY]: { [hashRef("room-a")]: "muted" } });
    expect(prefs.getRoomNotifyMode("room-a")).toBe("muted");
    expect(prefs.getChannelNotifyMode("room-a", "")).toBeNull();
    expect(prefs.effectiveNotifyMode("room-a", "")).toBe("muted");
    prefs.setRoomNotifyMode("room-a", "all", ["", "gamesgames"]);
    expect(prefs.effectiveNotifyMode("room-a", "")).toBe("all");
  });
});

describe("the original chat's own mode", () => {
  it("is stored apart from the room's, and read back", async () => {
    const { prefs, disk } = await load({});
    prefs.setChannelNotifyMode("room-a", "", "muted");
    expect(disk.has(ROOM_KEY)).toBe(false);
    const stored = JSON.parse(disk.get(CHANNEL_KEY)!) as Record<string, string>;
    expect(Object.values(stored)).toEqual(["muted"]);
    expect(stored).not.toHaveProperty(hashRef("room-a"));

    const again = await load({ [CHANNEL_KEY]: stored });
    expect(again.prefs.getRoomNotifyMode("room-a")).toBe("all");
    expect(again.prefs.effectiveNotifyMode("room-a", "")).toBe("muted");
    expect(again.prefs.effectiveNotifyMode("room-a", "gamesgames")).toBe("all");
    expect(again.prefs.effectiveNotifyMode("room-b", "")).toBe("all");
    // Muting the room is remembered as the room's, and drops nothing quieter.
    again.prefs.setRoomNotifyMode("room-a", "muted", ["", "gamesgames"]);
    expect(JSON.parse(again.disk.get(ROOM_KEY)!)).toEqual({ [hashRef("room-a")]: "muted" });
    expect(again.prefs.getChannelNotifyMode("room-a", "")).toBe("muted");
  });
});
