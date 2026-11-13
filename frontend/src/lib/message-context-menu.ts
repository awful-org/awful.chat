import { stripControlChars } from "$lib/actions/message-body";
import { MessageType, type Message } from "$lib/types/message";

/** Copy the complete source, not a truncated reply preview or plugin JSON. */
export function getCopyableMessageText(msg: Pick<Message, "type" | "content" | "meta">): string {
  if (![MessageType.Text, MessageType.Reply, MessageType.File].includes(msg.type)) return "";
  const text = msg.content || (msg.type === MessageType.File
    ? (msg.meta?.files ?? []).map((file) => file.filename).join("\n")
    : "");
  return stripControlChars(text);
}

/** Keep native context menus for selection, links, media and nested controls. */
const NATIVE_MENU =
  "a, button, input, textarea, select, label, img, video, audio, canvas, iframe, [role='button'], [role='dialog'], [role='menu'], [contenteditable='true']";

export function canOpenMessageMenu(
  target: EventTarget | null,
  row: Element,
  selection: Pick<Selection, "isCollapsed" | "anchorNode" | "focusNode"> | null,
): boolean {
  if (!target || typeof (target as Element).matches !== "function" || !row.contains(target as Node)) return false;
  for (let el = target as Element | null; el && el !== row; el = el.parentElement) {
    if (el.matches(NATIVE_MENU)) return false;
  }
  return !selection || selection.isCollapsed ||
    !(row.contains(selection.anchorNode) || row.contains(selection.focusNode));
}

export function messageMenuPosition(x: number, y: number, width: number, height: number, viewportWidth: number, viewportHeight: number) {
  const margin = 8;
  return {
    left: Math.max(margin, Math.min(x, viewportWidth - width - margin)),
    top: Math.max(margin, Math.min(y, viewportHeight - height - margin)),
  };
}
