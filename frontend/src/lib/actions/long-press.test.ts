import { describe, expect, it } from "vitest";
import { isMenuKey } from "./long-press";

describe("the keyboard's way to a context menu", () => {
  it("is the menu key or Shift+F10", () => {
    expect(isMenuKey({ key: "ContextMenu", shiftKey: false })).toBe(true);
    expect(isMenuKey({ key: "F10", shiftKey: true })).toBe(true);
  });

  it("is not F10 alone, nor Enter", () => {
    expect(isMenuKey({ key: "F10", shiftKey: false })).toBe(false);
    expect(isMenuKey({ key: "Enter", shiftKey: true })).toBe(false);
  });
});
