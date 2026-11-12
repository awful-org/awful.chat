import { describe, expect, it } from "vitest";
import { isBlankMessageSpot } from "./message-dblclick";

/**
 * The tests run without a DOM, so the row is a tiny fake: elements that know
 * their tag, parent and children, and a document whose caret and text boxes
 * say where the text is.
 */
type Fake = { tag: string; role?: string; parentElement: Fake | null; kids: Fake[] };

function el(tag: string, parent: Fake | null, role?: string): Fake {
  const node: Fake = { tag, role, parentElement: parent, kids: [] };
  parent?.kids.push(node);
  return node;
}

function asElement(node: Fake): Element {
  const contains = (n: Fake, other: Fake): boolean => n === other || (n.kids ?? []).some((k) => contains(k, other));
  return Object.assign(node, {
    matches: (selector: string) =>
      selector.split(",").map((s) => s.trim()).some((s) =>
        s === node.tag || (node.role !== undefined && s === `[role='${node.role}']`)),
    contains: (other: Fake) => contains(node, other),
  }) as unknown as Element;
}

const TEXT_BOX = { left: 0, right: 100, top: 0, bottom: 20 };

/** A document whose caret lands on `text` (or on nothing). */
function doc(text: { data: string } | null): Document {
  return {
    caretRangeFromPoint: () => (text ? { startContainer: text } : null),
    createRange: () => ({ selectNodeContents() {}, getClientRects: () => [TEXT_BOX] }),
  } as unknown as Document;
}

function textIn(parent: Fake, data: string) {
  const node = { nodeType: 3, data, parentElement: parent };
  parent.kids.push(node as unknown as Fake);
  return node;
}

function build() {
  const row = el("div", null, "button");
  const para = el("p", row);
  const text = textIn(para, "hello");
  const gap = el("div", row);
  const link = el("a", row);
  const inLink = el("span", link);
  const button = el("button", row);
  const img = el("img", row);
  const code = el("pre", row);
  for (const n of [row, para, gap, link, inLink, button, img, code]) asElement(n);
  return { row: row as unknown as Element, para, text, gap, inLink, button, img, code };
}

describe("double-click to reply", () => {
  it("replies from the row's empty space, even with the caret snapped to nearby text", () => {
    const { row, gap, text } = build();
    expect(isBlankMessageSpot(gap as unknown as Element, row, 400, 10, doc(text))).toBe(true);
  });

  it("leaves a double click on text to select a word", () => {
    const { row, para, text } = build();
    expect(isBlankMessageSpot(para as unknown as Element, row, 50, 10, doc(text))).toBe(false);
  });

  it("leaves links, buttons, pictures and code alone", () => {
    const { row, inLink, button, img, code } = build();
    for (const target of [inLink, button, img, code]) {
      expect(isBlankMessageSpot(target as unknown as Element, row, 400, 10, doc(null))).toBe(false);
    }
  });

  it("does not count the row's own button role, or whitespace between elements", () => {
    const { row, para } = build();
    const space = textIn(para, " ");
    expect(isBlankMessageSpot(row, row, 50, 10, doc(space))).toBe(true);
  });

  it("leaves the media viewer and file preview alone, though drawn inside the row", () => {
    const { row } = build();
    const dialog = asElement(el("div", row as unknown as Fake, "dialog"));
    const panel = asElement(el("div", dialog as unknown as Fake));
    expect(isBlankMessageSpot(panel, row, 400, 10, doc(null))).toBe(false);
  });

  it("ignores a click outside the row", () => {
    const { row } = build();
    const outside = asElement(el("div", null));
    expect(isBlankMessageSpot(outside, row, 0, 0, doc(null))).toBe(false);
  });
});
