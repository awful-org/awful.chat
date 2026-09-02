/**
 * install-prompt.svelte.ts - the browser's install offer, caught before the
 * app can miss it.
 *
 * `beforeinstallprompt` fires ONCE, early, and cannot be replayed: a listener
 * attached by a component that mounts a second later simply never hears it,
 * which is why the install dialog used to appear only sometimes. main.ts calls
 * capture() at module scope, before anything mounts, and the component reads
 * what was caught.
 *
 * Nothing here can install anything on its own - prompt() has to run from a
 * user gesture, and Safari has no such API at all, which is what the manual
 * path is for.
 */

const SNOOZE_KEY = "awful:install-snooze:v1";
/** "Maybe later" means later, not in three minutes. A month. */
const SNOOZE_MS = 30 * 24 * 60 * 60 * 1000;
/**
 * How long to wait for beforeinstallprompt before deciding it is not coming.
 * Chromium fires it during load; anything still silent after this either
 * cannot install (a browser with no PWA support) or installs by hand.
 */
const NO_PROMPT_AFTER_MS = 5000;

export const installState = $state({
  /** A real install prompt is in hand and prompt() will work. */
  ready: false,
  /** Running as an installed app already, so there is nothing to offer. */
  standalone: false,
  /** No prompt is coming, and this platform installs from the share sheet.
   *  iOS only: on a desktop browser with no install path there is nothing
   *  useful to say, so nothing is said. */
  manual: false,
});

let deferred: BeforeInstallPromptEvent | null = null;

export function isStandalone(): boolean {
  if (typeof window === "undefined") return false;
  return (
    window.matchMedia("(display-mode: standalone)").matches ||
    window.navigator.standalone === true
  );
}

/** iPhone/iPad, including the iPad that reports itself as a Mac - a Mac with
 *  a touchscreen is the tell. */
export function isIos(): boolean {
  if (typeof navigator === "undefined") return false;
  return (
    /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1)
  );
}

/** Called from main.ts at module scope. Idempotent. */
let capturing = false;
export function captureInstallPrompt(): void {
  if (capturing || typeof window === "undefined") return;
  capturing = true;

  installState.standalone = isStandalone();

  window.addEventListener("beforeinstallprompt", (e) => {
    // Without this the browser shows its own bar and never hands the event
    // over, so the app's offer and the browser's fight over the same screen.
    e.preventDefault();
    deferred = e;
    installState.ready = true;
    installState.manual = false;
  });

  window.addEventListener("appinstalled", () => {
    deferred = null;
    installState.ready = false;
    installState.manual = false;
    installState.standalone = true;
  });

  setTimeout(() => {
    if (deferred || installState.standalone || !isIos()) return;
    installState.manual = true;
  }, NO_PROMPT_AFTER_MS);
}

/** Whether the user has said "maybe later" recently enough to be left alone. */
export function installSnoozed(): boolean {
  try {
    const at = Number(localStorage.getItem(SNOOZE_KEY) ?? 0);
    return Number.isFinite(at) && Date.now() - at < SNOOZE_MS;
  } catch {
    return false;
  }
}

export function snoozeInstall(): void {
  try {
    localStorage.setItem(SNOOZE_KEY, String(Date.now()));
  } catch {
    // Storage blocked: the offer comes back next load. Not worth failing for.
  }
}

/**
 * Show the browser's own install dialog. MUST be called from a click: the
 * event is spent either way, so a rejected prompt leaves nothing to retry
 * with until the browser fires a fresh one.
 */
export async function promptInstall(): Promise<boolean> {
  const event = deferred;
  if (!event) return false;
  deferred = null;
  installState.ready = false;
  try {
    await event.prompt();
    const { outcome } = await event.userChoice;
    if (outcome !== "accepted") snoozeInstall();
    return outcome === "accepted";
  } catch {
    return false;
  }
}
