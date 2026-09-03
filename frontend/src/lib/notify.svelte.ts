import { playMessageSound } from "./sounds";
import { shouldPlayMessageSound, shouldShowNotification } from "./notify-rules";

/**
 * notify.svelte.ts - app badge and local notifications.
 *
 * Local-only, and everything here works with no server at all: a message that
 * arrived while the app is running but not being read (another tab, minimised,
 * another conversation on screen) and the unread count on the installed icon.
 *
 * Waking a CLOSED app is push, and that lives in push.svelte.ts: the relay
 * learns a push address and the fact that mail is waiting, never the message.
 * The two do not overlap - a push shows a generic notification from the
 * service worker, this one has the text because the app is already running.
 */

const PREF_KEY = "awful:notifications:v1";
const SOUND_PREF_KEY = "awful:message-sounds:v1";
const HIDE_PREVIEW_KEY = "awful:notify-hide-preview:v1";

export const notifyState = $state({
  /** User has switched notifications on in settings. */
  enabled: false,
  /** Browser-level permission, mirrored for the UI. */
  permission: "default" as NotificationPermission,
  supported: false,
  /** Play a sound for incoming messages. On by default; needs no permission. */
  soundsEnabled: true,
  /** Keep the message text off the lock screen: who it is from, not what it
   *  says. Off by default - a preview is the point of a notification. */
  hidePreview: false,
});

if (typeof window !== "undefined") {
  notifyState.supported = "Notification" in window;
  if (notifyState.supported) notifyState.permission = Notification.permission;
  try {
    notifyState.enabled =
      localStorage.getItem(PREF_KEY) === "1" &&
      notifyState.permission === "granted";
    notifyState.soundsEnabled = localStorage.getItem(SOUND_PREF_KEY) !== "0";
    notifyState.hidePreview = localStorage.getItem(HIDE_PREVIEW_KEY) === "1";
  } catch {}

  // A second tab flipping a switch should be reflected here, not fought.
  window.addEventListener("storage", (e) => {
    if (e.key === SOUND_PREF_KEY) {
      notifyState.soundsEnabled = e.newValue !== "0";
    }
    if (e.key === HIDE_PREVIEW_KEY) {
      notifyState.hidePreview = e.newValue === "1";
    }
    if (e.key === PREF_KEY) {
      notifyState.enabled =
        e.newValue === "1" && notifyState.permission === "granted";
    }
  });

  // A permission changed in the browser's own site settings fires nothing on
  // the page, so the switch stayed stuck at "denied" until a reload - right
  // after the user went and fixed it, which is the worst possible moment to
  // look broken. Wrapped in a try as well as a catch: some engines throw
  // synchronously for a permission name they do not know, and a throw here
  // would take the whole module - and with it the app - down at import.
  try {
    void navigator.permissions
      ?.query({ name: "notifications" as PermissionName })
      .then((status) => {
        const sync = () => {
          if (!notifyState.supported) return;
          notifyState.permission = Notification.permission;
          if (notifyState.permission !== "granted") {
            notifyState.enabled = false;
            return;
          }
          // Granted again: the switch goes back to what the user had set,
          // rather than making them find it and turn it on a second time.
          try {
            notifyState.enabled = localStorage.getItem(PREF_KEY) === "1";
          } catch {}
        };
        status.addEventListener("change", sync);
        sync();
      })
      .catch(() => {});
  } catch {
    // No permissions registry, or no notifications entry in it.
  }
}

export function setMessageSoundsEnabled(on: boolean): void {
  notifyState.soundsEnabled = on;
  try {
    localStorage.setItem(SOUND_PREF_KEY, on ? "1" : "0");
  } catch {}
}

export function setHidePreview(on: boolean): void {
  notifyState.hidePreview = on;
  try {
    localStorage.setItem(HIDE_PREVIEW_KEY, on ? "1" : "0");
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

/** A DM or a mention is worth a buzz in a pocket; a busy room is not. */
const URGENT_VIBRATE = [80, 40, 80];

/**
 * Notify about an incoming message.
 *
 * Fires whenever the conversation it belongs to is not the one being read -
 * the app being visible is not the same as this message being visible, and on
 * a phone it almost never is.
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
  /** A DM or a mention: worth a vibration, where room chatter is not. */
  urgent?: boolean;
  /** `body` is what somebody wrote, so the hide-preview switch replaces it.
   *  A count ("3 new messages") is not, and is left alone. */
  isPreview?: boolean;
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
  // Sound and notification now share a rule - what the reader can already
  // see is the conversation, not the app - but they are asked separately:
  // sounds need no permission and are on for people who never granted one.
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
  if (
    !shouldShowNotification({
      viewingConversation: opts.viewingConversation ?? false,
      focused: typeof document !== "undefined" && document.hasFocus(),
      hidden: typeof document !== "undefined" && document.hidden,
    })
  ) {
    return;
  }

  // Hidden previews keep the sender (a lock screen showing who wants you is
  // most of the value) and drop what they wrote.
  const body =
    notifyState.hidePreview && opts.isPreview !== false
      ? "New message"
      : opts.body.slice(0, 180);
  const vibrate = opts.urgent ? URGENT_VIBRATE : undefined;

  void (async () => {
    // Through the service worker when there is one: that is what enables
    // ACTION buttons (Open, inline Reply on Android) and is the only way
    // notifications work at all on Android. The page-Notification fallback
    // keeps browsers without an active registration covered.
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (reg?.showNotification) {
        await reg.showNotification(opts.title, {
          body,
          tag: opts.tag,
          // Without renotify, a tag that is already on screen is REPLACED in
          // silence: the second message in a conversation you are not reading
          // updated the text and made no sound, buzz or light at all.
          renotify: true,
          vibrate,
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
        body,
        tag: opts.tag,
        renotify: true,
        icon: "/pwa-192x192.png",
        badge: "/pwa-64x64.png",
        silent: false,
      } as NotificationOptions);
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

/**
 * Take down notifications that have already been delivered, by tag.
 *
 * Opening a conversation answers every notification it ever raised, and
 * leaving them on the lock screen makes the user dismiss by hand what they
 * have just read. Only the service worker's registration can list them - a
 * page-created Notification is not enumerable - so nothing to close is a
 * normal outcome, not a failure.
 *
 * Tags, not room codes: the tag is what the browser's notification store
 * holds, and announce.ts builds it from the conversation's opaque ref.
 */
export function closeNotificationsByTag(tags: string[]): void {
  if (tags.length === 0) return;
  void (async () => {
    try {
      const reg = await navigator.serviceWorker?.getRegistration();
      if (!reg?.getNotifications) return;
      for (const tag of tags) {
        for (const n of await reg.getNotifications({ tag })) n.close();
      }
    } catch {
      // No worker, or a browser that will not enumerate. Nothing to do.
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
