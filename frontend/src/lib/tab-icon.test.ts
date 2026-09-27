import { afterEach, describe, expect, it, vi } from "vitest";
import { showHeldElsewhereIcon } from "./tab-icon";

/** The one <link rel="icon"> the module touches, without a DOM. */
function fakeIconLink(href: string) {
  const attrs = new Map([["href", href]]);
  const link = {
    getAttribute: (name: string) => attrs.get(name) ?? null,
    setAttribute: (name: string, value: string) => void attrs.set(name, value),
  };
  vi.stubGlobal("document", { querySelector: () => link });
  return link;
}

afterEach(() => {
  showHeldElsewhereIcon(false);
  vi.unstubAllGlobals();
});

describe("showHeldElsewhereIcon", () => {
  it("swaps in the waiting icon and puts the page's own back", () => {
    const link = fakeIconLink("/favicon.ico");
    showHeldElsewhereIcon(true);
    expect(link.getAttribute("href")).toBe("/favicon-held.png");
    showHeldElsewhereIcon(false);
    expect(link.getAttribute("href")).toBe("/favicon.ico");
  });

  it("keeps the original across repeated swaps", () => {
    const link = fakeIconLink("/favicon.ico");
    showHeldElsewhereIcon(true);
    showHeldElsewhereIcon(true);
    showHeldElsewhereIcon(false);
    expect(link.getAttribute("href")).toBe("/favicon.ico");
  });

  it("leaves the icon alone when it was never swapped", () => {
    const link = fakeIconLink("/favicon.ico");
    showHeldElsewhereIcon(false);
    expect(link.getAttribute("href")).toBe("/favicon.ico");
  });
});
