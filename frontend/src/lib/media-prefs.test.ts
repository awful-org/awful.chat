import { afterEach, describe, expect, it, vi } from "vitest";
import { canLoadMedia, mediaPrefs, setExternalMedia } from "./media-prefs.svelte";

afterEach(() => { setExternalMedia(false); vi.unstubAllGlobals(); });
describe("external media privacy", () => {
  it("defaults on, with an explicit opt-out retaining local attachments and same-origin assets", () => {
    expect(mediaPrefs.externalMedia).toBe(true);
    setExternalMedia(false);
    vi.stubGlobal("location", { origin: "https://chat.example" });
    for (const url of ["blob:https://chat.example/123", "data:image/png;base64,AA==", "/logo.svg", "https://chat.example/logo.svg"]) expect(canLoadMedia(url)).toBe(true);
    for (const url of ["https://tracker.example/pixel", "//tracker.example/pixel", "/\\tracker.example/pixel", "javascript:alert(1)"]) expect(canLoadMedia(url)).toBe(false);
  });
  it("explicit opt-in permits remote HTTP media, and opt-out takes effect immediately", () => {
    setExternalMedia(true);
    expect(canLoadMedia("https://remote.example/a.gif")).toBe(true);
    expect(canLoadMedia("javascript:alert(1)")).toBe(false);
    setExternalMedia(false);
    expect(canLoadMedia("https://remote.example/a.gif")).toBe(false);
  });
});
