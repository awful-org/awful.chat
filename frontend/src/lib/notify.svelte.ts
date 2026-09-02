import { playMessageSound } from "./sounds";
import { shouldPlayMessageSound } from "./notify-rules";

/**
 * notify.svelte.ts - app badge and local notifications.
 *
 * There is no push here and there cannot be: no server holds your messages, so
 * nothing exists to wake the app up when it is closed. What IS possible is
 * telling you about a message that arrived while the app is running but not on
 * screen (another tab, minimised, phone in your pocket with the PWA open), and
 * putting the unread count on the installed icon. Both are local-only.
 */

const PREF_KEY = "awful:notifications:v1";
const SOUND_PREF_KEY = "awful:message-sounds:v1";

export const notifyState = $state({
  /** User has switched notifications on in settings. */
  enabled: false,
  /** Browser-level permission, mirrored for the UI. */
  permission: "default" as NotificationPermission,
  supported: false,
  /** Play a sound for incoming messages. On by default; needs no permission. */
  soundsEnabled: true,
});

if (typeof window !== "undefined") {
  notifyState.supported = "Notification" in window;
  if (notifyState.supported) notifyState.permission = Notification.permission;
  try {
    notifyState.enabled =
      localStorage.getItem(PREF_KEY) === "1" &&
      notifyState.permission === "granted";
    notifyState.soundsEnabled = localStorage.getItem(SOUND_PREF_KEY) !== "0";
  } catch {}

  // A second tab flipping a switch should be reflected here, not fought.
  window.addEventListener("storage", (e) => {
    if (e.key === SOUND_PREF_KEY) {
      notifyState.soundsEnabled = e.newValue !== "0";
    }
    if (e.key === PREF_KEY) {
      notifyState.enabled =
        e.newValue === "1" && notifyState.permission === "granted";
    }
  });
}

export function setMessageSoundsEnabled(on: boolean): void {
  notifyState.soundsEnabled = on;
  try {
    localStorage.setItem(SOUND_PREF_KEY, on ? "1" : "0");
  } catch {}
}

/**
 * Turn notifications on (asking the browser if needed) or off.
 * Must be called from a user gesture: browsers reject permission prompts
 * that are not tied to one.
 */
export async function setNotificationsEnabled(on: boolean): Promise<boolean> {
  if (!on) {
    notifyState.enabled = false;
    try {
      localStorage.setItem(PREF_KEY, "0");
    } catch {}
    return false;
  }
  if (!notifyState.supported) return false;

  let permission = Notification.permission;
  if (permission === "default") {
    try {
      permission = await Notification.requestPermission();
    } catch {
      return false;
    }
  }
  notifyState.permission = permission;
  notifyState.enabled = permission === "granted";
  try {
    localStorage.setItem(PREF_KEY, notifyState.enabled ? "1" : "0");
  } catch {}
  return notifyState.enabled;
}

/**
 * Notify about an incoming message.
 * Only fires when the app is actually out of sight - if you are looking at the
 * window, the message is already visible.
 */
export function notifyMessage(opts: {
  /** Shown on a lock screen and over a shoulder. Never a room code. */
  title: string;
  body: string;
  /** Collapses repeat notifications for the same conversation. Built from the
   *  conversation's opaque ref, not its room code. */
  tag: string;
  /** The conversation this message belongs to is the one on screen. */
  viewingConversation?: boolean;
  /**
   * Where a click (or inline reply) should land. Both this and `tag` survive
   * in the browser's (and on Android the OS's) own notification store, which
   * nothing here can lock or shred - so `roomCode` carries the OPAQUE ref
   * announce.ts mints, and notify-intents.ts turns it back into a room code
   * behind the device key when the intent is drained. The field keeps its name
   * because the service worker copies it straight into the stored intent.
   */
  data?: { roomCode: string; dmPeerDid?: string };
}): void {
  // The sound has its own rule, separate from the notification's hidden-only
  // one: it also plays while the app is visible but the message landed in
  // another room, or the window is unfocused.
  if (
    shouldPlayMessageSound({
      enabled: notifyState.soundsEnabled,
      viewingConversation: opts.viewingConversation ?? false,
      focused: typeof document !== "undefined" && document.hasFocus(),
    })
  ) {
    playMessageSound().catch(() => {});
  }

  if (!notifyState.enabled || !notifyState.supported) return;
  if (Notification.permission !== "granted") return;
  if (typeof document !== "undefined" && !document.hidden) return;

  void (async () => {
    // Through the service worker when there is one: that is what enables
    // ACTION buttons (Open, inline Reply on Android) and is the only way
    // notifications work at all on Android. The page-Notification fallback
    // keeps browsers without an active registration covered.
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg?.showNotification) {
        await reg.showNotification(opts.title, {
          body: opts.body.slice(0, 180),
          tag: opts.tag,
          icon: "/pwa-192x192.png",
          badge: "/pwa-64x64.png",
          silent: false,
          data: opts.data,
          // `type: "text"` (inline reply) is real but missing from the TS
          // lib; browsers without support show a plain button instead.
          actions: [
            { action: "open", title: "Open" },
            {
              action: "reply",
              title: "Reply",
              type: "text",
              placeholder: "Reply...",
            },
          ],
        } as NotificationOptions);
        return;
      }
    } catch {
      // fall through to the page notification
    }
    try {
      const notification = new Notification(opts.title, {
        body: opts.body.slice(0, 180),
        tag: opts.tag,
        icon: "/pwa-192x192.png",
        badge: "/pwa-64x64.png",
        silent: false,
      });
      notification.onclick = () => {
        try {
          window.focus();
        } catch {}
        notification.close();
      };
    } catch {
      // Failing to notify must never break message handling.
    }
  })();
}

/** Mirror the unread total onto the installed app icon. */
export function setBadge(count: number): void {
  const nav = navigator as Navigator & {
    setAppBadge?: (n?: number) => Promise<void>;
    clearAppBadge?: () => Promise<void>;
  };
  try {
    if (count > 0) nav.setAppBadge?.(count)?.catch(() => {});
    else nav.clearAppBadge?.()?.catch(() => {});
  } catch {}
}
