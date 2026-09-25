import { Keyboard } from "@lucide/svelte";
import type { Cmd } from "./types";

/**
 * Every keyboard shortcut the app actually binds, for the `?` scope and the
 * "Keyboard shortcuts" page. Read off the handlers, not wished for: a key
 * listed here that does nothing is worse than one not listed.
 */
const SHORTCUTS: ReadonlyArray<{ keys: string[]; does: string }> = [
  { keys: ["Ctrl", "K"], does: "Open or close this palette" },
  { keys: ["Ctrl", "F"], does: "Search this room" },
  { keys: ["Ctrl", "Shift", "F"], does: "Search all rooms" },
  { keys: ["Ctrl", "B"], does: "Collapse or expand the sidebar" },
  { keys: ["Enter"], does: "Send the message" },
  { keys: ["Shift", "Enter"], does: "New line in the message" },
  { keys: [":"], does: "Start an emoji, like :wave" },
  { keys: ["@"], does: "Mention someone" },
  { keys: ["/"], does: "Run a plugin command" },
  { keys: ["↑", "↓"], does: "Move through an emoji, mention or command list" },
  { keys: ["Enter"], does: "Pick from an emoji, mention or command list" },
  { keys: ["Esc"], does: "Close a list, menu, image or the pinned messages" },
  { keys: ["↑", "↓"], does: "Move a room, with its grip focused in the sidebar" },
];

/** Display rows: accepting one keeps the palette open and does nothing. */
export function shortcutRows(): Cmd[] {
  return SHORTCUTS.map((s, i) => ({
    id: `help.shortcut:${i}`,
    title: s.does,
    group: "Keyboard shortcuts",
    icon: Keyboard,
    shortcut: s.keys,
    action: { kind: "act", keepOpen: true, perform: () => {} },
  }));
}
