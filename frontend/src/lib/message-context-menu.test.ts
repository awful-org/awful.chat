import { describe, expect, it } from "vitest";
import { canOpenMessageMenu, getCopyableMessageText, messageMenuPosition } from "./message-context-menu";
import { MessageType, type Message } from "./types/message";

describe("message context menu copy text", () => {
  it("copies full text and replies, preserving markdown, URLs, whitespace and Unicode", () => {
    const content = `  **Hello** 👋\n\t\`code\` https://example.com/a.gif\n${"long message ".repeat(100)}`;
    for (const type of [MessageType.Text, MessageType.Reply] as const) {
      expect(getCopyableMessageText({ type, content })).toBe(content);
    }
  });

  it("copies file captions, or filenames for attachment-only messages", () => {
    const meta = { files: [{ filename: "photo.png" }, { filename: "notes.txt" }] } as Message["meta"];
    expect(getCopyableMessageText({ type: MessageType.File, content: "My **caption**", meta })).toBe("My **caption**");
    expect(getCopyableMessageText({ type: MessageType.File, content: "", meta })).toBe("photo.png\nnotes.txt");
    expect(getCopyableMessageText({ type: MessageType.File, content: "" })).toBe("");
  });

  it("does not expose plugin JSON or reaction payloads", () => {
    for (const type of [MessageType.PluginCard, MessageType.PluginUpdate, MessageType.Reaction] as const) {
      expect(getCopyableMessageText({ type, content: '{"private":"payload"}' })).toBe("");
    }
  });

  it("uses the code-copy control-character safety convention", () => {
    expect(getCopyableMessageText({ type: MessageType.Text, content: "a\u0000\u001b\r\u007Fb\n\tc" })).toBe("ab\n\tc");
    expect(getCopyableMessageText({ type: MessageType.Text, content: "" })).toBe("");
  });
});

function element(tag: string, parentElement: Element | null = null): Element {
  const node = {
    parentElement,
    matches: (selector: string) => selector.split(",").map((s) => s.trim()).includes(tag),
    contains(other: Node | null): boolean {
      for (let current = other as unknown as Element | null; current; current = current.parentElement) {
        if (current === node as unknown as Element) return true;
      }
      return false;
    },
  };
  return node as unknown as Element;
}

describe("message context menu targets", () => {
  it("opens on message text and empty space, ignoring the row's own button role", () => {
    const row = element("[role='button']");
    expect(canOpenMessageMenu(row, row, null)).toBe(true);
    expect(canOpenMessageMenu(element("p", row), row, null)).toBe(true);
    expect(canOpenMessageMenu(element("pre", row), row, null)).toBe(true);
  });

  it("leaves native link/media menus and nested interactive controls alone", () => {
    const row = element("div");
    for (const tag of ["a", "button", "img", "video", "audio", "input", "textarea", "canvas", "iframe", "[role='button']", "[role='dialog']", "[role='menu']", "[contenteditable='true']"]) {
      expect(canOpenMessageMenu(element("span", element(tag, row)), row, null), tag).toBe(false);
    }
  });

  it("leaves selected message text available to copy, but not unrelated selections", () => {
    const row = element("div");
    const text = element("p", row) as unknown as Node;
    const outside = element("p") as unknown as Node;
    for (const selection of [
      { isCollapsed: false, anchorNode: text, focusNode: text },
      { isCollapsed: false, anchorNode: outside, focusNode: text },
      { isCollapsed: false, anchorNode: text, focusNode: outside },
    ]) expect(canOpenMessageMenu(row, row, selection)).toBe(false);
    expect(canOpenMessageMenu(row, row, { isCollapsed: true, anchorNode: text, focusNode: text })).toBe(true);
    expect(canOpenMessageMenu(row, row, { isCollapsed: false, anchorNode: outside, focusNode: outside })).toBe(true);
  });

  it("rejects non-elements and targets outside the message", () => {
    const row = element("div");
    expect(canOpenMessageMenu(null, row, null)).toBe(false);
    expect(canOpenMessageMenu({} as EventTarget, row, null)).toBe(false);
    expect(canOpenMessageMenu(element("div"), row, null)).toBe(false);
  });
});

describe("message context menu position", () => {
  it("uses pointer coordinates when there is room", () => {
    expect(messageMenuPosition(100, 200, 208, 112, 1000, 800)).toEqual({ left: 100, top: 200 });
  });
  it("clamps all viewport edges and handles a viewport smaller than the panel", () => {
    expect(messageMenuPosition(999, 799, 208, 112, 1000, 800)).toEqual({ left: 784, top: 680 });
    expect(messageMenuPosition(-20, -10, 208, 112, 1000, 800)).toEqual({ left: 8, top: 8 });
    expect(messageMenuPosition(50, 50, 208, 112, 100, 80)).toEqual({ left: 8, top: 8 });
  });
});
