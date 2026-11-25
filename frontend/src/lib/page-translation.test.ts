import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { setPageTranslatable } from "./page-translation";

function root() {
  const attrs = new Map<string, string>();
  const list = new Set<string>(["dark"]);
  return {
    getAttribute: (k: string) => attrs.get(k) ?? null,
    setAttribute: (k: string, v: string) => void attrs.set(k, v),
    removeAttribute: (k: string) => void attrs.delete(k),
    classList: {
      toggle: (c: string, on: boolean) => void (on ? list.add(c) : list.delete(c)),
      contains: (c: string) => list.has(c),
    },
  } as unknown as HTMLElement;
}

describe("setPageTranslatable", () => {
  it("keeps translators off every page but the landing one", () => {
    const el = root();
    for (const route of ["app", "qs", "qc"] as const) {
      setPageTranslatable(route, el);
      expect(el.getAttribute("translate")).toBe("no");
      expect(el.classList.contains("notranslate")).toBe(true);
      setPageTranslatable("landing", el);
      expect(el.getAttribute("translate")).toBeNull();
      expect(el.classList.contains("notranslate")).toBe(false);
    }
  });

  it("is said in main.ts before anything is awaited", () => {
    const main = readFileSync("src/main.ts", "utf8");
    const at = main.indexOf("setPageTranslatable(");
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(main.indexOf("await "));
  });

  it("starts over with the app: the landing page links to it, full loads both", () => {
    const landing = readFileSync("src/Landing.svelte", "utf8");
    expect(landing).toContain('href="/app"');
    expect(landing).not.toContain("pushState");
  });
});
