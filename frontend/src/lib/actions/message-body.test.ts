import { beforeEach, describe, expect, it, vi } from "vitest";

const codeToHtml = vi.fn(async (code: string, opts: { lang: string }) => {
  if (opts.lang === "nope") throw new Error(`Language \`${opts.lang}\` is not included`);
  return `<pre class="shiki"><code>${opts.lang}:${code}</code></pre>`;
});
vi.mock("shiki", () => ({ codeToHtml }));

const { cachedHighlight, highlightCode, stripControlChars } = await import("./message-body");

beforeEach(() => {
  codeToHtml.mockClear();
});

describe("highlightCode", () => {
  it("tokenizes a block once, however often it mounts", async () => {
    const first = await highlightCode("let a = 1", "js");
    expect(first).toBe('<pre class="shiki"><code>js:let a = 1</code></pre>');
    expect(await highlightCode("let a = 1", "js")).toBe(first);
    expect(cachedHighlight("let a = 1", "js")).toBe(first);
    expect(codeToHtml).toHaveBeenCalledTimes(1);
  });

  it("shares one tokenization between blocks that ask at once", async () => {
    const all = await Promise.all([1, 2, 3].map(() => highlightCode("x = 2", "py")));
    expect(new Set(all).size).toBe(1);
    expect(codeToHtml).toHaveBeenCalledTimes(1);
  });

  it("keeps languages apart", async () => {
    await highlightCode("same", "js");
    await highlightCode("same", "ts");
    expect(codeToHtml).toHaveBeenCalledTimes(2);
  });

  it("does not remember a failure, so a grammar that loads later still highlights", async () => {
    codeToHtml.mockRejectedValueOnce(new Error("offline"));
    expect(await highlightCode("retry me", "js")).toBeNull();
    expect(await highlightCode("retry me", "js")).not.toBeNull();
    expect(await highlightCode("y", "nope")).toBeNull();
    expect(cachedHighlight("y", "nope")).toBeUndefined();
  });

  it("stays bounded, dropping what was used longest ago", async () => {
    await highlightCode("kept", "js");
    await highlightCode("dropped", "js");
    for (let k = 0; k < 1000; k++) {
      await highlightCode(`block ${k}`, "js");
      // Used again all along, so it is never the oldest.
      cachedHighlight("kept", "js");
    }
    codeToHtml.mockClear();
    await highlightCode("kept", "js");
    expect(codeToHtml).not.toHaveBeenCalled();
    await highlightCode("dropped", "js");
    expect(codeToHtml).toHaveBeenCalledTimes(1);
  });

  it("does not keep html larger than the whole cache", async () => {
    const huge = "x".repeat(3_000_000);
    await highlightCode(huge, "txt");
    expect(cachedHighlight(huge, "txt")).toBeUndefined();
    expect(cachedHighlight("kept", "js")).toBeDefined();
  });
});

describe("stripControlChars", () => {
  it("keeps newlines and tabs, drops the bytes a terminal acts on", () => {
    expect(stripControlChars("a\tb\nc\r\u001b[2Jd")).toBe("a\tb\nc[2Jd");
  });
});
