/**
 * Instance configuration, read at runtime instead of compiled in.
 *
 * These four values differ for every instance, and while they were inlined
 * by Vite every instance's main chunk differed too - even from identical
 * source with identical plugins. That makes a published per-commit hash
 * useless, because it matches nobody, and it buries "which relay does this
 * instance send my traffic through" inside minified JavaScript where a user
 * cannot read it.
 *
 * Served as /config.json instead. Two things follow: the bundle becomes the
 * same bytes everywhere, so it can be verified against a published build;
 * and an operator can point at a different relay without rebuilding.
 *
 * A production build inlines nothing: docker writes config.json at container
 * start (frontend/docker-entrypoint.d/40-awful-config.sh) and any other host
 * ships the file next to index.html. `pnpm dev` still falls back to the
 * repo-root .env so a checkout runs with no extra setup.
 */

export interface RuntimeConfig {
  /** Relay HTTP API: /og, /klipy, /turn-credentials. */
  apiUrl: string;
  /** libp2p multiaddr of the relay, including its peer id. */
  relayMultiaddr: string;
  /** One SFU, or several. Empty means this origin's own /sfu. */
  sfuUrls: string[];
  /** The /qs quick-send page. Off unless the instance turns it on. */
  useQs: boolean;
  /** The /qc quick-call page. Off unless the instance turns it on. */
  useQc: boolean;
}

/**
 * Anything but a plain yes is off. The value arrives as a JSON boolean from
 * the entrypoint, but an operator hand-editing config.json (or setting a
 * VITE_ variable, which is always a string) writes "true" - a flag that
 * silently stayed off because it was quoted is not worth the debugging.
 */
function flag(raw: unknown, fallback: boolean): boolean {
  if (typeof raw === "boolean") return raw;
  if (typeof raw !== "string") return fallback;
  const v = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return true;
  if (["0", "false", "no", "off", ""].includes(v)) return false;
  return fallback;
}

function splitList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
}

const EMPTY: RuntimeConfig = {
  apiUrl: "",
  relayMultiaddr: "",
  sfuUrls: [],
  useQs: false,
  useQc: false,
};

/**
 * The repo-root .env, for `pnpm dev` only.
 *
 * Deliberately behind a plain `import.meta.env.DEV` test, and nothing else in
 * this file may touch `import.meta.env`: vite replaces a dynamic read of that
 * object with an object literal holding EVERY VITE_ variable it can see, so
 * one such read in production code puts the relay peer id straight back into
 * the bundle - which is the whole thing being removed here. Written this way
 * the minifier deletes the branch, and a production bundle contains no
 * instance configuration at all. Dev keeps working with no config.json.
 */
function fromBuild(): RuntimeConfig {
  if (!import.meta.env.DEV) return EMPTY;
  const env = import.meta.env as unknown as Record<string, string | undefined>;
  return {
    apiUrl: env.VITE_API_URL ?? "",
    relayMultiaddr: env.VITE_RELAY_MULTIADDR ?? "",
    sfuUrls: splitList(env.VITE_SFU_URLS || env.VITE_SFU_URL),
    useQs: flag(env.VITE_USE_QS, false),
    useQc: flag(env.VITE_USE_QC, false),
  };
}

function coerce(raw: unknown, fallback: RuntimeConfig): RuntimeConfig {
  if (!raw || typeof raw !== "object") return fallback;
  const r = raw as Record<string, unknown>;
  const str = (v: unknown, dflt: string) =>
    typeof v === "string" && v.trim() ? v.trim() : dflt;
  const sfu = Array.isArray(r.sfuUrls)
    ? r.sfuUrls.filter((u): u is string => typeof u === "string" && !!u.trim())
    : splitList(r.sfuUrl);
  return {
    apiUrl: str(r.apiUrl, fallback.apiUrl),
    relayMultiaddr: str(r.relayMultiaddr, fallback.relayMultiaddr),
    sfuUrls: sfu.length ? sfu.map((u) => u.trim()) : fallback.sfuUrls,
    useQs: flag(r.useQs, fallback.useQs),
    useQc: flag(r.useQc, fallback.useQc),
  };
}

let current: RuntimeConfig = fromBuild();
// The in-flight (or settled) load. A plain `loaded` flag would be set before
// the fetch resolves, so a second caller during the load would be handed the
// pre-load values and never know.
let pending: Promise<RuntimeConfig> | null = null;
let configured = false;

/**
 * On a first launch the app mounts after this, so it is what a new visitor
 * waits on before seeing anything at all. Long enough for a slow same-origin
 * static file, short enough that a stalled connection (lie-fi, a captive
 * portal) does not leave somebody staring at an empty page: an unconfigured
 * app that says so beats one that never appears.
 */
const LOAD_TIMEOUT_MS = 4000;

/**
 * The last configuration this instance served, kept on the device.
 *
 * Every launch used to wait a round trip for /config.json before anything
 * appeared - the installed app included, for which it is the one request no
 * cache answers - and a stalled one blanked the screen for the whole timeout
 * and then ran with no relay. A launch that has a copy starts from it at once
 * and fetches the file behind the app: what the instance serves now applies
 * the moment it arrives, and is what the next launch starts from. Only a
 * first launch, or one after the site's data was cleared, waits.
 *
 * Per base path, because two builds published under different paths of one
 * origin are two instances.
 */
const SAVED_KEY = `awful_runtime_config:${import.meta.env.BASE_URL || "/"}`;

function savedConfig(): RuntimeConfig | null {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(SAVED_KEY) ?? "null");
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    return coerce(raw, fromBuild());
  } catch {
    // No storage (private mode, blocked) or a damaged copy: a first launch.
    return null;
  }
}

function saveConfig(body: string): void {
  try {
    localStorage.setItem(SAVED_KEY, body);
  } catch {
    // Full or blocked: the next launch waits for the network, as it did.
  }
}

/**
 * Fetch /config.json once, before anything reads configuration.
 *
 * A missing or unparseable file is not an error: nothing is overwritten and
 * the app runs with empty addresses (or, in dev, the repo-root .env).
 * Awaited by main.ts before the app mounts, because several modules read
 * configuration while they are still initialising - which costs nothing when
 * there is a saved copy to start from (see SAVED_KEY).
 */
export function loadRuntimeConfig(): Promise<RuntimeConfig> {
  if (pending) return pending;
  const saved = savedConfig();
  if (!saved) return (pending = fetchConfig());
  current = saved;
  configured = true;
  pending = Promise.resolve(current);
  void fetchConfig().then((fresh) => {
    // A failed refresh forgot the load (see failed), so a retry can run.
    if (pending) pending = Promise.resolve(fresh);
  });
  return pending;
}

/** The first retry's wait, doubled after every miss up to the cap. */
const RETRY_FIRST_MS = 5_000;
const RETRY_MAX_MS = 60_000;
let retryDelay = RETRY_FIRST_MS;
let retryArmed = false;

/**
 * A load that failed must not be remembered as an answer.
 *
 * Launching an installed PWA while offline is a supported path - the service
 * worker serves the shell from cache and the app starts - and the config
 * fetch is the one request that cannot be served from a cache. Left
 * memoized, that blip would run the whole session with no relay and no SFU,
 * with nothing logged, until the user thought to reload.
 */
function failed(why: string, transient: boolean, err?: unknown): void {
  pending = null;
  if (configured) {
    console.warn(
      `[config] ${why} - running with the configuration it served last time.`,
      err ?? ""
    );
  } else {
    console.error(
      `[config] ${why} - this instance is running with no relay, no SFU and no ` +
        `API. Serving /config.json (see frontend/docker-entrypoint.d) fixes it.`,
      err ?? ""
    );
  }
  armRetry(transient);
}

/**
 * Load again once there is a reason to think it would work. Any failure is
 * tried again when the browser says it is back online. A blip (offline, a
 * timeout, a server error) also when the page is shown again and, while the
 * app has nothing to run on, after a wait: lie-fi and a captive portal never
 * fire "online", and an installed app has no reload button, so that event
 * alone ran a whole session with no relay. A file that is not there is the
 * operator's to fix - asking again on every glance at the tab would only
 * fill the console, `pnpm dev`'s included. One retry per failure, whichever
 * reason comes first.
 */
function armRetry(transient: boolean): void {
  if (retryArmed || typeof window === "undefined") return;
  retryArmed = true;
  const doc = transient && typeof document !== "undefined" ? document : null;
  const onTimer = transient && !configured;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const retry = () => {
    if (!retryArmed) return;
    retryArmed = false;
    clearTimeout(timer);
    window.removeEventListener("online", retry);
    doc?.removeEventListener("visibilitychange", onShown);
    void loadRuntimeConfig();
  };
  const onShown = () => {
    if (doc?.visibilityState === "visible") retry();
  };
  window.addEventListener("online", retry);
  doc?.addEventListener("visibilitychange", onShown);
  if (onTimer) {
    timer = setTimeout(retry, retryDelay);
    retryDelay = Math.min(retryDelay * 2, RETRY_MAX_MS);
  }
}

async function fetchConfig(): Promise<RuntimeConfig> {
  try {
    // Relative to the app's base, not to "/": an instance published under
    // a subpath (a GitHub Pages project site, say) serves its config there.
    const base = import.meta.env.BASE_URL || "/";
    const res = await fetch(`${base.replace(/\/$/, "")}/config.json`, {
      cache: "no-store",
      signal: AbortSignal.timeout(LOAD_TIMEOUT_MS),
    });
    if (!res.ok) {
      failed(`/config.json returned ${res.status}`, res.status >= 500);
      return current;
    }
    const type = res.headers.get("content-type") ?? "";
    const body = await res.text();
    // A single-page app answers unknown paths with index.html and a 200,
    // so status alone cannot tell "absent" from "present". Taking the
    // fallback page as configuration would blank every value.
    const isHtml =
      /^text\/html\b/i.test(type) || /^\s*(<!doctype html|<html\b)/i.test(body);
    if (isHtml) {
      failed("/config.json is missing (the server answered with the app page)", false);
      return current;
    }
    current = coerce(JSON.parse(body), fromBuild());
    configured = true;
    retryDelay = RETRY_FIRST_MS;
    saveConfig(body);
  } catch (err) {
    // Offline, blocked, timed out, or malformed JSON - only the last is not
    // a blip.
    failed("/config.json could not be read", !(err instanceof SyntaxError), err);
  }
  return current;
}

/** Whether the served configuration was actually read. */
export function isConfigured(): boolean {
  return configured;
}

/** For tests and for callers that must not race the initial load. */
export function setRuntimeConfig(next: Partial<RuntimeConfig>): void {
  current = { ...current, ...next };
  pending = Promise.resolve(current);
  configured = true;
}

export function runtimeConfig(): RuntimeConfig {
  return current;
}

export function apiUrl(): string {
  return current.apiUrl;
}

export function relayMultiaddr(): string {
  return current.relayMultiaddr;
}

export function sfuUrls(): string[] {
  return current.sfuUrls;
}

export function useQs(): boolean {
  return current.useQs;
}

export function useQc(): boolean {
  return current.useQc;
}
