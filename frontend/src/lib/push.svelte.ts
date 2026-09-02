import { ed25519 } from "@noble/curves/ed25519.js";
import { isUnlocked, requireSession } from "$lib/identity/identity";
import { apiUrl } from "$lib/runtime-config";

/**
 * push.svelte.ts - Web Push, so a phone with the app closed still rings.
 *
 * What the relay learns is a push address for this device and the fact that
 * something is waiting for it. Never the content: the payload it sends is
 * `{"t":"mail"}` and nothing else, the service worker shows a generic
 * "New message", and the app fetches the mailbox itself once it is open and
 * unlocked. The relay already knows a mailbox has post for you - that is what
 * a mailbox is - so this adds one address and no new knowledge of the message.
 *
 * On by default, because a chat that cannot reach your lock screen is a chat
 * you miss. The switch in settings turns it off and tells the relay to forget
 * the address; the browser's own permission is the harder off switch, and
 * nothing here can ask for it without a user gesture (see NotifyPrompt).
 *
 * Deliberately NOT importing transport.svelte.ts at module load: this module
 * is read while the app is still starting, and that import pulls in the whole
 * libp2p stack. The peer id is fetched with a lazy import at the one moment
 * it is needed.
 */

const PREF_KEY = "awful:push:v1";
/** The relay's VAPID key the live subscription was minted under. A rotated
 *  key makes every old subscription undeliverable, and the browser will not
 *  say so - the endpoint keeps working and the pushes go nowhere. */
const KEY_KEY = "awful:push-key:v1";

// A call, not a const: this module is imported while the app is still
// starting, and a value captured here would freeze whatever the build baked
// in before /config.json had been read. Same reasoning as mailbox.svelte.ts.
const API = () => apiUrl();

export const pushPrefs = $state({
  // Anything but an explicit "off" means on, including devices that have
  // never seen the switch.
  enabled:
    typeof localStorage === "undefined" ||
    localStorage.getItem(PREF_KEY) !== "0",
});

const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));

/**
 * The mailbox's auth fields, byte for byte: the relay checks ONE signature
 * string for every authenticated call, so subscribing proves the same thing
 * collecting does - that this client holds the key behind the DID.
 *
 * Rebuilt here rather than imported because mailbox.svelte.ts keeps it
 * private; the string below must stay identical to the one it signs.
 */
function authFields(): { did: string; ts: number; sig: string } {
  const session = requireSession();
  const ts = Math.floor(Date.now() / 1000);
  const sig = ed25519.sign(
    new TextEncoder().encode(`awful-mailbox:${ts}`),
    session.privateKey
  );
  return { did: session.did, ts, sig: b64(sig) };
}

/** base64url (what VAPID keys are published as) to the raw bytes
 *  pushManager.subscribe wants. */
function decodeKey(base64url: string): Uint8Array<ArrayBuffer> {
  const padded = base64url
    .replace(/-/g, "+")
    .replace(/_/g, "/")
    .padEnd(Math.ceil(base64url.length / 4) * 4, "=");
  return Uint8Array.from(atob(padded), (c) => c.charCodeAt(0));
}

interface PushConfig {
  enabled: boolean;
  publicKey: string;
}

let configCache: Promise<PushConfig | null> | null = null;

/** What the relay says about its own push support. Cached for the session:
 *  it is instance configuration, not state. */
function pushConfig(): Promise<PushConfig | null> {
  return (configCache ??= (async () => {
    if (!API()) return null;
    try {
      const res = await fetch(`${API()}/push/config`, {
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const raw = (await res.json()) as Partial<PushConfig>;
      if (raw?.enabled !== true || typeof raw.publicKey !== "string") {
        return null;
      }
      return { enabled: true, publicKey: raw.publicKey };
    } catch {
      // Relay down, or an instance whose relay has no push. Neither is an
      // error worth a stack trace: the app just stays local-only.
      return null;
    }
  })());
}

/** Our libp2p peer id, the way the DM and mailbox paths get it. */
async function device(): Promise<string> {
  const { peerId } = await import("$lib/transport/transport.svelte");
  return peerId();
}

function stored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function remember(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Storage blocked: worst case a key rotation is noticed a session late.
  }
}

/** What the last POST said, so an unchanged subscription is not re-sent on
 *  every unlock. Session-scoped: a relay restart is cheap to re-tell. */
let lastPosted = "";
let inFlight: Promise<boolean> | null = null;

async function post(path: string, body: object): Promise<boolean> {
  const res = await fetch(`${API()}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  return res.ok;
}

/**
 * Make sure the relay can wake this device, if the user wants it to and every
 * piece is in place. Safe to call on every unlock: it is a no-op once the
 * subscription the relay holds is the one the browser has.
 *
 * @returns whether a live subscription is registered with the relay.
 */
export function ensurePushSubscription(): Promise<boolean> {
  return (inFlight ??= subscribe().finally(() => {
    inFlight = null;
  }));
}

/**
 * What the last attempt found, for Settings to say so. "push-service" is the
 * browser's own service refusing to mint an endpoint: Brave ships with
 * Google's push service switched off, and Chromium reports that as
 * "Registration failed - push service error".
 */
export const pushState = $state<{
  status: "unknown" | "subscribed" | "unavailable";
  reason: "push-service" | "relay" | "other" | null;
}>({ status: "unknown", reason: null });

function classify(err: unknown): "push-service" | "other" {
  const text = err instanceof Error ? `${err.name} ${err.message}` : String(err);
  return /push service|AbortError|NotSupportedError/i.test(text)
    ? "push-service"
    : "other";
}

async function subscribe(): Promise<boolean> {
  if (!pushPrefs.enabled) return false;
  // A push service that refused once refuses every unlock in this session;
  // asking again only fills the console. A toggle in Settings retries.
  if (pushState.reason === "push-service") return false;
  if (typeof window === "undefined") return false;
  if (typeof Notification === "undefined") return false;
  // Asking here would be rejected anyway: the prompt needs a user gesture,
  // which is what the banner is for.
  if (Notification.permission !== "granted") return false;
  if (!("serviceWorker" in navigator) || !("PushManager" in window)) {
    return false;
  }
  if (!isUnlocked() || !API()) return false;

  try {
    const config = await pushConfig();
    if (!config) return false;

    const reg = await navigator.serviceWorker.getRegistration();
    if (!reg?.pushManager) return false;

    let sub = await reg.pushManager.getSubscription();
    if (sub && stored(KEY_KEY) !== config.publicKey) {
      // Minted under a key the relay no longer signs with. Its endpoint would
      // keep accepting pushes that the push service then refuses to deliver.
      await sub.unsubscribe().catch(() => {});
      sub = null;
    }
    if (!sub) {
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeKey(config.publicKey),
      });
    }

    const json = sub.toJSON();
    const keys = json.keys ?? {};
    if (!json.endpoint || !keys.p256dh || !keys.auth) return false;

    const dev = await device();
    const marker = `${config.publicKey}|${json.endpoint}|${dev}`;
    if (marker === lastPosted) return true;

    const ok = await post("/push/subscribe", {
      ...authFields(),
      device: dev,
      subscription: {
        endpoint: json.endpoint,
        keys: { p256dh: keys.p256dh, auth: keys.auth },
      },
    });
    if (!ok) {
      pushState.status = "unavailable";
      pushState.reason = "relay";
      return false;
    }
    lastPosted = marker;
    remember(KEY_KEY, config.publicKey);
    pushState.status = "subscribed";
    pushState.reason = null;
    return true;
  } catch (err) {
    // A push service that refuses to mint an endpoint (no network, a browser
    // with push disabled at build time) costs nothing here: the app still
    // notifies locally while it is running. Settings says why.
    console.warn("[push] subscribe failed:", err);
    pushState.status = "unavailable";
    pushState.reason = classify(err);
    return false;
  }
}

/**
 * Stop being wakeable: drop the browser's subscription AND tell the relay to
 * forget the address. Both, in that order - unsubscribing alone leaves the
 * relay pushing at a dead endpoint, and telling the relay alone leaves the
 * browser holding a subscription it would hand straight back.
 */
export async function disablePush(): Promise<void> {
  lastPosted = "";
  remember(KEY_KEY, null);
  let dev = "";
  try {
    dev = await device();
  } catch {
    // Transport never started: the relay is told what it can be told.
  }
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    const sub = await reg?.pushManager?.getSubscription();
    await sub?.unsubscribe();
  } catch {
    // Already gone, or no worker. Nothing to undo.
  }
  try {
    if (API() && isUnlocked()) {
      await post("/push/unsubscribe", { ...authFields(), device: dev });
    }
  } catch (err) {
    // The relay drops an endpoint the push service rejects anyway, so a
    // failure here costs a few dead pushes, not correctness.
    console.warn("[push] unsubscribe failed:", err);
  }
}

/** The settings switch. Off takes effect immediately; on only gets as far as
 *  the browser's permission allows, which is the banner's job to ask for. */
export function setPushEnabled(on: boolean): void {
  pushPrefs.enabled = on;
  try {
    localStorage.setItem(PREF_KEY, on ? "1" : "0");
  } catch {
    // Storage blocked: the choice just does not survive a reload.
  }
  if (on) {
    pushState.reason = null;
    void ensurePushSubscription();
  }
  else void disablePush();
}

// A second tab flipping the switch should be reflected here, not fought.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === PREF_KEY) pushPrefs.enabled = e.newValue !== "0";
  });
}
