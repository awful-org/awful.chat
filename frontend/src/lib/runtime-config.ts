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
}

function splitList(raw: unknown): string[] {
  if (typeof raw !== "string") return [];
  return raw
    .split(",")
    .map((u) => u.trim())
    .filter(Boolean);
}

const EMPTY: RuntimeConfig = { apiUrl: "", relayMultiaddr: "", sfuUrls: [] };

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
  };
}

let current: RuntimeConfig = fromBuild();
// The in-flight (or settled) load. A plain `loaded` flag would be set before
// the fetch resolves, so a second caller during the load would be handed the
// pre-load values and never know.
let pending: Promise<RuntimeConfig> | null = null;
let configured = false;

/**
 * The app mounts after this, so it is what a user waits on before seeing
 * anything at all. Long enough for a slow same-origin static file, short
 * enough that a stalled connection (lie-fi, a captive portal) does not leave
 * somebody staring at an empty page: an unconfigured app that says so beats
 * one that never appears.
 */
const LOAD_TIMEOUT_MS = 4000;

/**
 * Fetch /config.json once, before anything reads configuration.
 *
 * A missing or unparseable file is not an error: nothing is overwritten and
 * the app runs with empty addresses (or, in dev, the repo-root .env).
 * Awaited by main.ts before the app mounts, because several modules read
 * configuration while they are still initialising.
 */
export function loadRuntimeConfig(): Promise<RuntimeConfig> {
  return (pending ??= fetchConfig());
}

/**
 * A load that failed must not be remembered as an answer.
 *
 * Launching an installed PWA while offline is a supported path - the service
 * worker serves the shell from cache and the app starts - and the config
 * fetch is the one request that cannot be served from a cache. Left
 * memoized, that blip would run the whole session with no relay and no SFU,
 * with nothing logged, until the user thought to reload.
 */
function failed(why: string, err?: unknown): void {
  console.error(
    `[config] ${why} - this instance is running with no relay, no SFU and no ` +
      `API. Serving /config.json (see frontend/docker-entrypoint.d) fixes it.`,
    err ?? ""
  );
  pending = null;
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => void loadRuntimeConfig(), {
      once: true,
    });
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
      failed(`/config.json returned ${res.status}`);
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
      failed("/config.json is missing (the server answered with the app page)");
      return current;
    }
    current = coerce(JSON.parse(body), fromBuild());
    configured = true;
  } catch (err) {
    // Offline, blocked, timed out, or malformed JSON.
    failed("/config.json could not be read", err);
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
