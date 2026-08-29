/**
 * Display preferences for the chat view. Device-local, like media-prefs: a
 * preference about this screen, not part of the identity or profile.
 */

import {
  DEFAULT_CHAT_FONT_SIZE,
  DEFAULT_FONT_STACK,
  FONT_STACK_IDS,
  clampChatFontSize,
  sanitizeFontFamily,
} from "./chat-font";

const ITALIC_KEY = "awful:italic-own-name:v1";
const PEER_COLORS_KEY = "awful:show-peer-colors:v1";
const SIDEBAR_COLLAPSED_KEY = "awful:sidebar-collapsed:v1";
const CALL_CHAT_BESIDE_KEY = "awful:call-chat-beside:v1";
const CONNECTION_INFO_KEY = "awful:debug-connection-info:v1";
const CALL_PIP_KEY = "awful:call-pip:v1";
const CHAT_FONT_SIZE_KEY = "awful:chat-font-size:v1";
const CHAT_FONT_FAMILY_KEY = "awful:chat-font-family:v1";

function readStored(key: string, defaultValue: boolean): boolean {
  if (typeof localStorage === "undefined") return defaultValue;
  const v = localStorage.getItem(key);
  return v === null ? defaultValue : v === "1";
}

function readChatFontSize(): number {
  if (typeof localStorage === "undefined") return DEFAULT_CHAT_FONT_SIZE;
  const raw = localStorage.getItem(CHAT_FONT_SIZE_KEY);
  // Number(null) is 0, which would clamp to the minimum instead of the
  // default, so the missing-key case must be checked before conversion.
  return raw === null ? DEFAULT_CHAT_FONT_SIZE : clampChatFontSize(raw);
}

// Shared by the reader, the setter, and the cross-tab listener: a stored id
// is kept as-is, a custom family is sanitized, and anything that survives
// neither check falls back to the default stack.
function normalizeChatFontFamily(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_FONT_STACK;
  if ((FONT_STACK_IDS as readonly string[]).includes(value)) return value;
  return sanitizeFontFamily(value) ?? DEFAULT_FONT_STACK;
}

export const displayPrefs = $state({
  /** Render your own name above your messages in italics. */
  italicOwnName: readStored(ITALIC_KEY, false),
  /** Show other people's custom colors; off keeps every remote name default. */
  showPeerNicknameColors: readStored(PEER_COLORS_KEY, true),
  /** Desktop only: the room sidebar shows as an icon rail. */
  sidebarCollapsed: readStored(SIDEBAR_COLLAPSED_KEY, false),
  /** Desktop only: in a call the chat sits beside the stage, not below it. */
  callChatBeside: readStored(CALL_CHAT_BESIDE_KEY, false),
  /**
   * Debug: render the relay/connection indicators - the transport status
   * overlay, the "Relayed" peer badges, the sidebar connection dot and text,
   * and the room "Connected" pill. Off by default keeps them hidden.
   */
  showConnectionInfo: readStored(CONNECTION_INFO_KEY, false),
  /**
   * Keep the call in view when it is not on screen: the floating panel when
   * you move to another room or DM, and the browser's own PiP window on a
   * tab switch (Chromium). Off means the call is only the stage.
   */
  callPip: readStored(CALL_PIP_KEY, true),
  /** Chat message text size, in pixels. */
  chatFontSize: readChatFontSize(),
  /** Chat message font: a FontStackId, or a sanitized custom family name. */
  chatFontFamily: normalizeChatFontFamily(
    typeof localStorage === "undefined"
      ? null
      : localStorage.getItem(CHAT_FONT_FAMILY_KEY),
  ),
});

export function setCallPip(on: boolean): void {
  displayPrefs.callPip = on;
  try {
    localStorage.setItem(CALL_PIP_KEY, on ? "1" : "0");
  } catch {
    // Storage blocked: the choice just does not survive a reload.
  }
}

export function setItalicOwnName(on: boolean): void {
  displayPrefs.italicOwnName = on;
  try {
    localStorage.setItem(ITALIC_KEY, on ? "1" : "0");
  } catch {
    // Storage blocked: the choice just does not survive a reload.
  }
}

export function setShowPeerNicknameColors(on: boolean): void {
  displayPrefs.showPeerNicknameColors = on;
  try {
    localStorage.setItem(PEER_COLORS_KEY, on ? "1" : "0");
  } catch {
    // Storage blocked: the choice just does not survive a reload.
  }
}

export function setSidebarCollapsed(on: boolean): void {
  displayPrefs.sidebarCollapsed = on;
  try {
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, on ? "1" : "0");
  } catch {
    // Storage blocked: the choice just does not survive a reload.
  }
}

export function setCallChatBeside(on: boolean): void {
  displayPrefs.callChatBeside = on;
  try {
    localStorage.setItem(CALL_CHAT_BESIDE_KEY, on ? "1" : "0");
  } catch {
    // Storage blocked: the choice just does not survive a reload.
  }
}

export function setShowConnectionInfo(on: boolean): void {
  displayPrefs.showConnectionInfo = on;
  try {
    localStorage.setItem(CONNECTION_INFO_KEY, on ? "1" : "0");
  } catch {
    // Storage blocked: the choice just does not survive a reload.
  }
}

export function setChatFontSize(px: number): void {
  displayPrefs.chatFontSize = clampChatFontSize(px);
  try {
    localStorage.setItem(CHAT_FONT_SIZE_KEY, String(displayPrefs.chatFontSize));
  } catch {
    // Storage blocked: the choice just does not survive a reload.
  }
}

export function setChatFontFamily(value: string): void {
  displayPrefs.chatFontFamily = normalizeChatFontFamily(value);
  try {
    localStorage.setItem(CHAT_FONT_FAMILY_KEY, displayPrefs.chatFontFamily);
  } catch {
    // Storage blocked: the choice just does not survive a reload.
  }
}

// A second tab flipping a switch should be reflected here, not fought.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === ITALIC_KEY)
      displayPrefs.italicOwnName = e.newValue === "1";
    if (e.key === PEER_COLORS_KEY)
      displayPrefs.showPeerNicknameColors = e.newValue === "1";
    if (e.key === SIDEBAR_COLLAPSED_KEY)
      displayPrefs.sidebarCollapsed = e.newValue === "1";
    if (e.key === CALL_CHAT_BESIDE_KEY)
      displayPrefs.callChatBeside = e.newValue === "1";
    if (e.key === CONNECTION_INFO_KEY)
      displayPrefs.showConnectionInfo = e.newValue === "1";
    if (e.key === CHAT_FONT_SIZE_KEY)
      displayPrefs.chatFontSize =
        e.newValue === null
          ? DEFAULT_CHAT_FONT_SIZE
          : clampChatFontSize(e.newValue);
    if (e.key === CHAT_FONT_FAMILY_KEY)
      displayPrefs.chatFontFamily = normalizeChatFontFamily(e.newValue);
  });
}