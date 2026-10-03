import { describe, expect, it } from "vitest";
import { shortcutRows } from "./shortcuts";
import { shortcutKeys } from "$lib/platform";

describe("shortcutRows", () => {
  // The app's handlers take Cmd or Ctrl alike, so a list that spells out
  // either one is wrong on half the machines that read it.
  it("names the app's shortcut key as Mod, never a platform's own key", () => {
    const keys = shortcutRows().flatMap((row) => row.shortcut ?? []);
    expect(keys).toContain("Mod");
    expect(keys).not.toContain("Ctrl");
    expect(keys).not.toContain("⌘");
  });

  it("reads as Ctrl off a Mac and ⌘ on one", () => {
    const palette = shortcutRows().find((row) => row.title === "Open or close this palette");
    expect(shortcutKeys(palette?.shortcut ?? [], false)).toEqual(["Ctrl", "K"]);
    expect(shortcutKeys(palette?.shortcut ?? [], true)).toEqual(["⌘", "K"]);
  });
});
