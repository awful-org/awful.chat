import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_ERRORS_PER_ROOM,
  MAX_ERROR_LENGTH,
  clearPluginErrors,
  cleanErrorMessage,
  dismissPluginError,
  pluginErrors,
  showPluginError,
} from "./plugin-errors.svelte";

describe("plugin errors", () => {
  beforeEach(() => clearPluginErrors());

  it("shows one line of plain text, bounded", () => {
    expect(cleanErrorMessage("  Use /ping @alice\n‮twice ")).toBe("Use /ping @alice twice");
    expect([...cleanErrorMessage("x".repeat(MAX_ERROR_LENGTH * 2))!]).toHaveLength(MAX_ERROR_LENGTH);
    for (const bad of [null, 3, {}, "", "  ​ "]) expect(cleanErrorMessage(bad)).toBeNull();
  });

  it("keeps the same complaint once, at the bottom", () => {
    showPluginError("ping", "room-a", "Nobody to ping");
    showPluginError("poll", "room-a", "A poll needs two options");
    showPluginError("ping", "room-a", "Nobody to ping");
    expect(pluginErrors.entries.map((e) => e.pluginId)).toEqual(["poll", "ping"]);
  });

  it("keeps the last few per room, and rooms apart", () => {
    for (let i = 0; i < MAX_ERRORS_PER_ROOM + 2; i++) showPluginError("ping", "room-a", `error ${i}`);
    showPluginError("ping", "room-b", "elsewhere");
    const inA = pluginErrors.entries.filter((e) => e.roomCode === "room-a");
    expect(inA.map((e) => e.message)).toEqual(
      Array.from({ length: MAX_ERRORS_PER_ROOM }, (_, i) => `error ${i + 2}`),
    );
    expect(pluginErrors.entries.filter((e) => e.roomCode === "room-b")).toHaveLength(1);
  });

  it("goes when dismissed, and needs a room", () => {
    showPluginError("ping", "", "no room");
    expect(pluginErrors.entries).toHaveLength(0);
    showPluginError("ping", "room-a", "x");
    dismissPluginError(pluginErrors.entries[0].id);
    expect(pluginErrors.entries).toHaveLength(0);
  });
});
