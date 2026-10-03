import { afterEach, describe, expect, it, vi } from "vitest";
import { isMacLike, isShortcutModifier, shortcutKeys, shortcutLabel } from "./platform";

const MAC_SAFARI =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const IPHONE =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1";
const WINDOWS_CHROME =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const ANDROID =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Mobile Safari/537.36";

describe("isMacLike", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("trusts client hints first", () => {
    expect(isMacLike({ userAgentData: { platform: "macOS" } })).toBe(true);
    expect(isMacLike({ userAgentData: { platform: "Windows" } })).toBe(false);
    expect(isMacLike({ userAgentData: { platform: "Linux" } })).toBe(false);
    expect(isMacLike({ userAgentData: { platform: "Chrome OS" } })).toBe(false);
  });

  it("lets client hints overrule a platform string that says otherwise", () => {
    expect(
      isMacLike({ userAgentData: { platform: "Windows" }, platform: "MacIntel" })
    ).toBe(false);
  });

  it("falls back to navigator.platform", () => {
    expect(isMacLike({ platform: "MacIntel", userAgent: MAC_SAFARI })).toBe(true);
    expect(isMacLike({ platform: "iPhone", userAgent: IPHONE })).toBe(true);
    expect(isMacLike({ platform: "Win32", userAgent: WINDOWS_CHROME })).toBe(false);
    expect(isMacLike({ platform: "Linux armv81", userAgent: ANDROID })).toBe(false);
  });

  it("counts an iPad asking for the desktop site, which says MacIntel", () => {
    expect(isMacLike({ platform: "MacIntel" })).toBe(true);
  });

  it("falls back to the user agent when there is no platform", () => {
    expect(isMacLike({ userAgent: MAC_SAFARI })).toBe(true);
    expect(isMacLike({ userAgent: IPHONE })).toBe(true);
    expect(isMacLike({ userAgent: WINDOWS_CHROME })).toBe(false);
    expect(isMacLike({ userAgent: ANDROID })).toBe(false);
  });

  it("is not a Mac when there is nothing to go on", () => {
    expect(isMacLike({})).toBe(false);
    expect(isMacLike(undefined)).toBe(false);
  });

  it("reads the real navigator by default", () => {
    vi.stubGlobal("navigator", { platform: "MacIntel", userAgent: MAC_SAFARI });
    expect(isMacLike()).toBe(true);
    expect(shortcutLabel(["Mod", "K"])).toBe("⌘K");
    vi.stubGlobal("navigator", { platform: "Win32", userAgent: WINDOWS_CHROME });
    expect(isMacLike()).toBe(false);
    expect(shortcutLabel(["Mod", "K"])).toBe("Ctrl+K");
  });
});

describe("shortcutKeys", () => {
  it("shows the shortcut key as Ctrl off a Mac and keeps the order", () => {
    expect(shortcutKeys(["Mod", "K"], false)).toEqual(["Ctrl", "K"]);
    expect(shortcutKeys(["Mod", "Shift", "F"], false)).toEqual(["Ctrl", "Shift", "F"]);
    expect(shortcutKeys(["Alt", "↓"], false)).toEqual(["Alt", "↓"]);
  });

  it("shows the shortcut key as ⌘ on a Mac", () => {
    expect(shortcutKeys(["Mod", "K"], true)).toEqual(["⌘", "K"]);
    expect(shortcutKeys(["Mod", "B"], true)).toEqual(["⌘", "B"]);
  });

  it("puts Mac modifiers in the Mac's own order, before the key", () => {
    expect(shortcutKeys(["Mod", "Shift", "F"], true)).toEqual(["⇧", "⌘", "F"]);
    expect(shortcutKeys(["Shift", "Alt", "Ctrl", "Mod", "X"], true)).toEqual([
      "⌃",
      "⌥",
      "⇧",
      "⌘",
      "X",
    ]);
  });

  it("keeps a real Control key as ⌃ on a Mac, not ⌘", () => {
    expect(shortcutKeys(["Ctrl", "Tab"], true)).toEqual(["⌃", "Tab"]);
  });

  it("passes keys that are not modifiers through", () => {
    expect(shortcutKeys(["Shift", "Enter"], true)).toEqual(["⇧", "Enter"]);
    expect(shortcutKeys(["↑", "↓"], true)).toEqual(["↑", "↓"]);
    expect(shortcutKeys(["Esc"], false)).toEqual(["Esc"]);
  });
});

describe("shortcutLabel", () => {
  it("runs Mac glyphs together, as Mac menus do", () => {
    expect(shortcutLabel(["Mod", "K"], true)).toBe("⌘K");
    expect(shortcutLabel(["Mod", "Shift", "F"], true)).toBe("⇧⌘F");
  });

  it("joins with + everywhere else", () => {
    expect(shortcutLabel(["Mod", "K"], false)).toBe("Ctrl+K");
    expect(shortcutLabel(["Mod", "Shift", "F"], false)).toBe("Ctrl+Shift+F");
  });
});

describe("isShortcutModifier", () => {
  const key = (metaKey: boolean, ctrlKey: boolean) => ({ metaKey, ctrlKey });

  it("takes Cmd on a Mac and leaves Ctrl to text editing", () => {
    expect(isShortcutModifier(key(true, false), true)).toBe(true);
    expect(isShortcutModifier(key(false, true), true)).toBe(false);
    expect(isShortcutModifier(key(true, true), true)).toBe(false);
    expect(isShortcutModifier(key(false, false), true)).toBe(false);
  });

  it("takes Ctrl elsewhere and leaves the Windows or Super key to the system", () => {
    expect(isShortcutModifier(key(false, true), false)).toBe(true);
    expect(isShortcutModifier(key(true, false), false)).toBe(false);
    expect(isShortcutModifier(key(true, true), false)).toBe(false);
    expect(isShortcutModifier(key(false, false), false)).toBe(false);
  });
});
