/**
 * Chat text appearance: curated font stacks plus a validated custom-family
 * path. Every curated stack ends in (or, for `sans`, guarantees) a generic
 * CSS family so an absent font degrades instead of the message text
 * vanishing.
 */

export type FontStackId =
  | "mono"
  | "sans"
  | "serif"
  | "rounded"
  | "verdana"
  | "trebuchet";

interface FontStackEntry {
  id: FontStackId;
  label: string;
  stack: string;
}

// Order is display order in the settings picker; `mono` first because it is
// the historical default and must stay a visual no-op for existing users.
export const FONT_STACKS: readonly FontStackEntry[] = [
  {
    id: "mono",
    label: "Monospace",
    stack:
      'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  },
  {
    id: "sans",
    label: "System sans",
    stack:
      'ui-sans-serif, system-ui, sans-serif, "Apple Color Emoji", "Segoe UI Emoji", "Segoe UI Symbol", "Noto Color Emoji"',
  },
  {
    id: "serif",
    label: "Serif",
    stack: 'ui-serif, Georgia, Cambria, "Times New Roman", Times, serif',
  },
  {
    id: "rounded",
    label: "Rounded",
    stack: 'ui-rounded, "SF Pro Rounded", system-ui, sans-serif',
  },
  {
    id: "verdana",
    label: "Verdana",
    stack: "Verdana, Geneva, sans-serif",
  },
  {
    id: "trebuchet",
    label: "Trebuchet",
    stack: '"Trebuchet MS", Tahoma, sans-serif',
  },
];

export const FONT_STACK_IDS: readonly FontStackId[] = FONT_STACKS.map(
  (f) => f.id,
);

export const DEFAULT_FONT_STACK: FontStackId = "mono";

export const MIN_CHAT_FONT_SIZE = 11;
export const MAX_CHAT_FONT_SIZE = 24;
// Matches --text-sm (0.875rem) at a 16px root, so the default is a visual
// no-op against the current hardcoded size.
export const DEFAULT_CHAT_FONT_SIZE = 14;

/** Accepts anything (including a localStorage string) and returns a valid, in-range size. */
export function clampChatFontSize(n: unknown): number {
  const num = typeof n === "string" ? Number(n) : n;
  if (typeof num !== "number" || !Number.isFinite(num)) {
    return DEFAULT_CHAT_FONT_SIZE;
  }
  return Math.max(
    MIN_CHAT_FONT_SIZE,
    Math.min(MAX_CHAT_FONT_SIZE, Math.round(num)),
  );
}

/** Longest custom family name we keep; anything past this is truncated, not rejected. */
const MAX_FONT_FAMILY_LENGTH = 64;

// Security boundary: the sanitized result is interpolated into an inline
// `style` attribute by resolveChatFontStack, so a crafted family name is a
// CSS/HTML injection vector. Anything that could close the property, open a
// tag, or reference an external resource is rejected outright rather than
// stripped, so a caller can't smuggle a payload past a partial filter.
const FORBIDDEN_CHARS = /[;{}<>()"'\\\r\n]/;
const URL_SUBSTRING = /url/i;

/** Accepts a user-supplied font-family name and returns a safe value, or null if it can't be made safe. */
export function sanitizeFontFamily(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  if (FORBIDDEN_CHARS.test(raw) || URL_SUBSTRING.test(raw)) return null;
  const collapsed = raw.trim().replace(/\s+/g, " ");
  if (collapsed.length === 0) return null;
  return collapsed.slice(0, MAX_FONT_FAMILY_LENGTH);
}

/** The single resolver both the settings UI and the chat container use to turn a stored preference into a CSS value. */
export function resolveChatFontStack(value: string): string {
  const known = FONT_STACKS.find((f) => f.id === value);
  if (known) return known.stack;
  // sanitizeFontFamily rejects `"`, so wrapping the survivor in quotes here
  // cannot be used to break out of the family name.
  const monoStack = FONT_STACKS.find((f) => f.id === DEFAULT_FONT_STACK)!
    .stack;
  const family = sanitizeFontFamily(value);
  return family === null ? monoStack : `"${family}", ${monoStack}`;
}
