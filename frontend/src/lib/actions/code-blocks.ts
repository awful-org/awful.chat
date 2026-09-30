/**
 * The fenced blocks in a rendered message body (markdown.ts): highlight each
 * one, and answer each one's copy button. Every block, not only the first.
 *
 * Attached with the body's html as its argument, so a new body - an edit, a
 * late mention name - re-runs it and a stale highlight never lands.
 */
import type { Attachment } from "svelte/attachments";

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

export function codeBlocks(html: string): Attachment<HTMLElement> {
  return (node) => {
    void html;
    let live = true;

    // After this flush: the body's {@html} may not be in the DOM yet when an
    // attachment on its parent runs.
    queueMicrotask(() => {
      const blocks = [...node.querySelectorAll<HTMLElement>("pre[data-lang]")];
      if (!live || !blocks.length) return;
      // Loaded on demand: the highlighter engine plus its wasm is well over
      // half a megabyte, and most sessions never see a code block.
      void import("shiki")
        .then(({ codeToHtml }) => {
          for (const pre of blocks) {
            codeToHtml(pre.textContent ?? "", { lang: pre.dataset.lang || "text", theme: "github-dark" })
              .then((highlighted) => {
                if (!live || !pre.isConnected) return;
                const tpl = document.createElement("template");
                tpl.innerHTML = highlighted;
                const next = tpl.content.firstElementChild;
                if (!next) return;
                // Keep the block's own classes (the room left for the copy
                // button, the code font and size): shiki's <pre> has none of them.
                next.classList.add(...pre.classList);
                pre.replaceWith(next);
              })
              // An unknown language keeps the plain block it already is.
              .catch(() => {});
          }
        })
        .catch(() => {});
    });

    const timers = new WeakMap<HTMLElement, ReturnType<typeof setTimeout>>();
    const onClick = async (e: MouseEvent) => {
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

    return () => {
      live = false;
      node.removeEventListener("click", onClick);
    };
  };
}
