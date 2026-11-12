/**
 * Double-click to reply, as in WhatsApp Web: a double click on a message's
 * empty space replies to it, like the swipe and the Reply button. Anywhere
 * that already means something to a double click is left alone: text, where
 * it selects a word, and anything you can click or that is media.
 */

/**
 * Things a double click belongs to, never the row behind them. A dialog or
 * menu counts too: the media viewer and file preview are drawn inside the
 * message's own markup, so a double click in their empty space would
 * otherwise reach the row under the overlay.
 */
const OWN_CLICKS =
  "a, button, input, textarea, select, label, img, video, audio, canvas, iframe, svg, pre, [role='button'], [role='dialog'], [role='menu'], [contenteditable='true']";

/**
 * Whether a double click at (x, y) on `target` landed on `row`'s empty space.
 * The row itself counts as a button for keyboard use, so the walk stops at it.
 */
export function isBlankMessageSpot(
  target: EventTarget | null,
  row: Element,
  x: number,
  y: number,
  doc: Document = document,
): boolean {
  if (!isElement(target) || !row.contains(target)) return false;
  for (let el: Element | null = target; el && el !== row; el = el.parentElement) {
    if (el.matches(OWN_CLICKS)) return false;
  }
  return !isOverText(row, x, y, doc);
}

/**
 * Whether (x, y) is over a character of text inside `row`. The caret lands on
 * the nearest text even from the empty space beside a line, so this checks
 * that the point is inside the text's own boxes, not just near them.
 */
function isOverText(row: Element, x: number, y: number, doc: Document): boolean {
  const node = textNodeAt(doc, x, y);
  if (!node || !row.contains(node) || !node.data.trim()) return false;
  const range = doc.createRange();
  range.selectNodeContents(node);
  return [...range.getClientRects()].some(
    (r) => x >= r.left - 1 && x <= r.right + 1 && y >= r.top - 1 && y <= r.bottom + 1,
  );
}

function textNodeAt(doc: Document, x: number, y: number): Text | null {
  const d = doc as Document & {
    caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node } | null;
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
  };
  const node = d.caretPositionFromPoint
    ? d.caretPositionFromPoint(x, y)?.offsetNode
    : d.caretRangeFromPoint?.(x, y)?.startContainer;
  return node?.nodeType === TEXT_NODE ? (node as Text) : null;
}

const TEXT_NODE = 3;

function isElement(target: EventTarget | null): target is Element {
  return typeof (target as Element | null)?.matches === "function";
}
