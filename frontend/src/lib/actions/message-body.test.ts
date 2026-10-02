import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const codeToHtml = vi.fn(async (code: string, opts: { lang: string }) => {
  if (opts.lang === "nope") throw new Error(`Language \`${opts.lang}\` is not included`);
  return `<pre class="shiki"><code>${opts.lang}:${code}</code></pre>`;
});
vi.mock("shiki", () => ({ codeToHtml }));

const { cachedHighlight, highlightCode, messageBody, stripControlChars } = await import("./message-body");

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

  it("counts the code a block is kept by, not only its html", async () => {
    // A key is a block's whole code: counting the html alone, 200 blocks
    // of 16K characters held 3M more than the bound allowed.
    const a = "a".repeat(600_000);
    const b = "b".repeat(600_000);
    await highlightCode(a, "txt");
    await highlightCode(b, "txt");
    expect(cachedHighlight(a, "txt")).toBeUndefined();
    expect(cachedHighlight(b, "txt")).toBeDefined();
  });
});

/** A fenced block's <pre>, as much of one as the attachment touches. */
function block(code: string) {
  const pre = {
    textContent: code,
    dataset: { lang: "js" },
    classList: ["pr-9"],
    isConnected: true,
    replaceWith: vi.fn(() => {
      pre.isConnected = false;
    }),
  };
  return pre;
}
type Block = ReturnType<typeof block>;

/** An IntersectionObserver the test tells what has come on screen. */
class Observer {
  static made: Observer[] = [];
  watched = new Set<unknown>();
  disconnected = false;
  constructor(
    private callback: (entries: { isIntersecting: boolean; target: unknown }[]) => void,
    public init?: IntersectionObserverInit,
  ) {
    Observer.made.push(this);
  }
  observe(target: unknown) {
    this.watched.add(target);
  }
  unobserve(target: unknown) {
    this.watched.delete(target);
  }
  disconnect() {
    this.disconnected = true;
    this.watched.clear();
  }
  show(...targets: Block[]) {
    this.callback(targets.map((target) => ({ isIntersecting: true, target })));
  }
}

describe("messageBody", () => {
  let idle: (() => void)[] = [];
  const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
  /** Idle moments, one after another, until nothing asks for another. */
  async function idleTime() {
    await settle();
    while (idle.length) {
      idle.shift()!();
      await settle();
    }
  }
  /** The attachment on a body holding these blocks, after its first look; its teardown. */
  async function attach(...blocks: Block[]) {
    const body = { querySelectorAll: () => blocks, addEventListener() {}, removeEventListener() {} };
    const teardown = messageBody("")(body as unknown as HTMLElement) as () => void;
    await settle();
    return teardown;
  }

  beforeEach(() => {
    idle = [];
    Observer.made = [];
    vi.stubGlobal("IntersectionObserver", Observer);
    vi.stubGlobal("requestIdleCallback", (run: () => void) => idle.push(run));
    vi.stubGlobal("document", {
      createElement: () => ({ innerHTML: "", content: { firstElementChild: { classList: { add() {} } } } }),
    });
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("highlights a block once it comes on screen, one per idle moment", async () => {
    const [a, b, c] = [block("on screen a"), block("on screen b"), block("scrolled past")];
    await attach(a, b, c);
    const [observer] = Observer.made;
    // Ahead of the list's own scroll box, which a rootMargin never reached.
    expect(observer.init).toEqual({ scrollMargin: "200px" });
    expect([...observer.watched]).toEqual([a, b, c]);
    expect(codeToHtml).not.toHaveBeenCalled();

    observer.show(a, b);
    expect([...observer.watched]).toEqual([c]);
    expect(codeToHtml).not.toHaveBeenCalled();
    idle.shift()!();
    await settle();
    expect(codeToHtml).toHaveBeenCalledTimes(1);
    expect(a.replaceWith).toHaveBeenCalledTimes(1);
    expect(idle).toHaveLength(1);
    await idleTime();
    expect(codeToHtml.mock.calls.map(([code]) => code)).toEqual(["on screen a", "on screen b"]);
    expect(b.replaceWith).toHaveBeenCalledTimes(1);
    expect(c.replaceWith).not.toHaveBeenCalled();
  });

  it("tokenizes a block shown in two messages once", async () => {
    const [d, e] = [block("pasted twice"), block("pasted twice")];
    await attach(d);
    await attach(e);
    Observer.made[0].show(d);
    Observer.made[1].show(e);
    await idleTime();
    expect(codeToHtml).toHaveBeenCalledTimes(1);
    expect(d.replaceWith).toHaveBeenCalledTimes(1);
    expect(e.replaceWith).toHaveBeenCalledTimes(1);
  });

  it("swaps in a block highlighted before at once, with nothing to wait for", async () => {
    await highlightCode("seen before", "js");
    codeToHtml.mockClear();
    const f = block("seen before");
    await attach(f);
    expect(f.replaceWith).toHaveBeenCalledTimes(1);
    expect(Observer.made).toHaveLength(0);
    expect(idle).toHaveLength(0);
    expect(codeToHtml).not.toHaveBeenCalled();
  });

  it("does nothing more for a body once it is gone, and lets go of its observer", async () => {
    const g = block("gone before its turn");
    const teardown = await attach(g);
    const [observer] = Observer.made;
    observer.show(g);
    teardown();
    expect(observer.disconnected).toBe(true);
    await idleTime();
    expect(codeToHtml).not.toHaveBeenCalled();
    expect(g.replaceWith).not.toHaveBeenCalled();

    // Gone before it even looked: nothing is watched at all.
    const body = { querySelectorAll: () => [block("never looked at")], addEventListener() {}, removeEventListener() {} };
    (messageBody("")(body as unknown as HTMLElement) as () => void)();
    await idleTime();
    expect(Observer.made).toHaveLength(1);
  });

  it("skips a block no longer in the page", async () => {
    const h = block("taken out");
    await attach(h);
    Observer.made[0].show(h);
    h.isConnected = false;
    await idleTime();
    expect(codeToHtml).not.toHaveBeenCalled();
  });
});

describe("stripControlChars", () => {
  it("keeps newlines and tabs, drops the bytes a terminal acts on", () => {
    expect(stripControlChars("a\tb\nc\r\u001b[2Jd")).toBe("a\tb\nc[2Jd");
  });
});
