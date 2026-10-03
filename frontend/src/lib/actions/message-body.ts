/**
 * What a rendered message body (markdown.ts) needs once it is on screen:
 * every fenced block highlighted, every copy button answered, and every
 * spoiler revealed on a click or Enter/Space.
 *
 * Attached with the body's html as its argument, so a new body - an edit, a
 * late mention name - re-runs it and a stale highlight never lands.
 */
import type { Attachment } from "svelte/attachments";

/**
 * Highlighted html by language and code, used longest ago first (a Map
 * keeps insertion order). Highlighting runs on the main thread, and the
 * message list is not virtualized: every block was tokenized again on each
 * mount - the room reopened, scrolled back to, the message re-rendered.
 */
const highlighted = new Map<string, string>();
/** Characters held, keys and html both: a key is a block's whole code. */
let highlightedChars = 0;
const CACHE_ENTRIES = 200;
/** About 4 MB at most; one block's html is a few hundred KB at worst. */
const CACHE_CHARS = 2_000_000;
/** In flight, so blocks that ask at once share one tokenization. */
const pending = new Map<string, Promise<string | null>>();

const cacheKey = (code: string, lang: string) => `${lang}\n${code}`;

/** The html this block was highlighted to before, if it is still kept. */
export function cachedHighlight(code: string, lang: string): string | undefined {
  const key = cacheKey(code, lang);
  const html = highlighted.get(key);
  if (html !== undefined) {
    highlighted.delete(key);
    highlighted.set(key, html);
  }
  return html;
}

function remember(key: string, html: string): void {
  if (key.length + html.length > CACHE_CHARS) return;
  const before = highlighted.get(key);
  if (before !== undefined) {
    highlighted.delete(key);
    highlightedChars -= key.length + before.length;
  }
  highlighted.set(key, html);
  highlightedChars += key.length + html.length;
  for (const [old, oldHtml] of highlighted) {
    if (highlighted.size <= CACHE_ENTRIES && highlightedChars <= CACHE_CHARS) break;
    highlighted.delete(old);
    highlightedChars -= old.length + oldHtml.length;
  }
}

/**
 * The block as highlighted html, or null for a language shiki has no
 * grammar for, or cannot load right now. A failure is not kept: offline,
 * a grammar's chunk fails to load, and it may load the next time.
 */
export function highlightCode(code: string, lang: string): Promise<string | null> {
  const hit = cachedHighlight(code, lang);
  if (hit !== undefined) return Promise.resolve(hit);
  const key = cacheKey(code, lang);
  let work = pending.get(key);
  if (!work) {
    // Loaded on demand: the highlighter engine plus its wasm is well over
    // half a megabyte, and most sessions never see a code block.
    work = import("shiki")
      .then(({ codeToHtml }) => codeToHtml(code, { lang, theme: "github-dark" }))
      .then(
        (html) => {
          remember(key, html);
          return html;
        },
        () => null
      )
      .finally(() => pending.delete(key));
    pending.set(key, work);
  }
  return work;
}

/**
 * The block replaced by its highlighted copy. It keeps the block's own
 * classes (the room left for the copy button, the code font and size):
 * shiki's <pre> has none of them.
 */
function swapIn(pre: HTMLElement, html: string): void {
  const tpl = document.createElement("template");
  tpl.innerHTML = html;
  const next = tpl.content.firstElementChild;
  if (!next) return;
  next.classList.add(...pre.classList);
  pre.replaceWith(next);
}

/**
 * Blocks on screen and not yet highlighted, done one per idle moment: the
 * first loads shiki's engine and wasm, and tokenizing a long block takes a
 * while, all on the main thread, so none of it runs while a room opens or
 * scrolls, nor in one long stretch for a page of blocks.
 */
const queue: { pre: HTMLElement; live: () => boolean }[] = [];
let draining = false;
/** Blocks observed whose first on-screen report has not come in yet. */
let unreported = 0;

/**
 * Whether highlighting may still change the height of what is on screen: a
 * block not yet reported on or off screen, or one queued or being done. The
 * chat view waits for this before it shows a conversation it is opening.
 */
export function highlightBusy(): boolean {
  return unreported > 0 || draining || queue.length > 0;
}

function whenIdle(run: () => void): void {
  if (typeof requestIdleCallback === "function") requestIdleCallback(run, { timeout: 1000 });
  else setTimeout(run, 50);
}

function drain(): void {
  const next = queue.shift();
  const done = () => {
    if (queue.length) whenIdle(drain);
    else draining = false;
  };
  if (!next || !next.live() || !next.pre.isConnected) return done();
  void highlightCode(next.pre.textContent ?? "", next.pre.dataset.lang || "text")
    .then((html) => {
      // An unknown language keeps the plain block it already is.
      if (html !== null && next.live() && next.pre.isConnected) swapIn(next.pre, html);
    })
    .catch(() => {})
    .finally(done);
}

function enqueue(pre: HTMLElement, live: () => boolean): void {
  queue.push({ pre, live });
  if (draining) return;
  draining = true;
  whenIdle(drain);
}

/**
 * Drop the C0 controls, keeping only newline and tab (and DEL, which behaves
 * like one).
 *
 * A fenced block is peer text on its way to a terminal, and the bytes that
 * do not show on screen are the dangerous ones: a `\r` rewrites the line the
 * reader thinks they pasted, and an escape byte can drive the terminal
 * itself. What was copied has to be what was displayed.
 */
export function stripControlChars(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\u0000-\u0008\u000B-\u001F\u007F]/g, "");
}

export function messageBody(html: string): Attachment<HTMLElement> {
  return (node) => {
    void html;
    let live = true;
    const isLive = () => live;
    let observer: IntersectionObserver | undefined;
    let dropUnreported = () => {};

    // After this flush: the body's {@html} may not be in the DOM yet when an
    // attachment on its parent runs.
    queueMicrotask(() => {
      const blocks = [...node.querySelectorAll<HTMLElement>("pre[data-lang]")];
      if (!live || !blocks.length) return;
      const waiting: HTMLElement[] = [];
      for (const pre of blocks) {
        // Highlighted before: in place at once, with no plain block first.
        const html = cachedHighlight(pre.textContent ?? "", pre.dataset.lang || "text");
        if (html !== undefined) swapIn(pre, html);
        else waiting.push(pre);
      }
      if (!waiting.length) return;
      if (typeof IntersectionObserver !== "function") {
        for (const pre of waiting) enqueue(pre, isLive);
        return;
      }
      // The rest as they come on screen: a block scrolled past is never done.
      // A little ahead of that, by scrollMargin, which widens the message
      // list's own scroll box. A rootMargin only widens the viewport's, and
      // the list clipped the block before it got there. Where scrollMargin
      // is not known, a block waits until it is in view.
      const ahead: IntersectionObserverInit & { scrollMargin?: string } = {
        scrollMargin: "200px",
      };
      const reported = new WeakSet<Element>();
      const report = (target: Element) => {
        if (reported.has(target)) return;
        reported.add(target);
        unreported--;
      };
      observer = new IntersectionObserver((entries) => {
        for (const entry of entries) {
          report(entry.target);
          if (!entry.isIntersecting) continue;
          observer?.unobserve(entry.target);
          enqueue(entry.target as HTMLElement, isLive);
        }
      }, ahead);
      for (const pre of waiting) observer.observe(pre);
      unreported += waiting.length;
      // A body taken down before the observer spoke never will.
      dropUnreported = () => {
        for (const pre of waiting) report(pre);
      };
    });

    const reveal = (e: Event): boolean => {
      const spoiler = (e.target as Element | null)?.closest<HTMLElement>("[data-spoiler]");
      if (!spoiler || !node.contains(spoiler) || spoiler.hasAttribute("data-revealed")) return false;
      // The first click shows it; it does not also follow a link inside.
      e.preventDefault();
      spoiler.setAttribute("data-revealed", "");
      spoiler.removeAttribute("role");
      spoiler.removeAttribute("tabindex");
      spoiler.removeAttribute("aria-label");
      return true;
    };
    const onKeydown = (e: KeyboardEvent) => {
      if (e.key === "Enter" || e.key === " ") reveal(e);
    };

    const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
    const onClick = async (e: MouseEvent) => {
      if (reveal(e)) return;
      const button = (e.target as Element | null)?.closest<HTMLElement>("[data-copy-code]");
      if (!button || !node.contains(button)) return;
      const text = button.closest("[data-code-block]")?.querySelector("pre")?.textContent ?? "";
      try {
        await navigator.clipboard.writeText(stripControlChars(text));
      } catch {
        // Clipboard blocked (insecure context, denied permission): the code
        // is on screen and selectable.
        return;
      }
      button.dataset.copied = "";
      button.setAttribute("aria-label", "Copied");
      // A second click restarts the tick instead of an earlier timer clearing it.
      clearTimeout(timers.get(button));
      timers.set(
        button,
        setTimeout(() => {
          delete button.dataset.copied;
          button.setAttribute("aria-label", "Copy code");
        }, 1200),
      );
    };
    node.addEventListener("click", onClick);
    node.addEventListener("keydown", onKeydown);

    return () => {
      live = false;
      observer?.disconnect();
      dropUnreported();
      node.removeEventListener("click", onClick);
      node.removeEventListener("keydown", onKeydown);
    };
  };
}
