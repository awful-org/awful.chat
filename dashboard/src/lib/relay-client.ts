/**
 * The relay's operator read endpoints.
 *
 * Both routes are absent unless the operator sets `TELEMETRY_ADMIN_TOKEN`, and
 * the relay answers 404 in that case on purpose: it must not advertise a
 * console that does not exist. A 404 is therefore a CONFIGURATION answer, not
 * a missing bundle, and this module says so in the message it returns.
 *
 * The token is a parameter. It is never read from or written to storage here.
 * See the note on `relay` in `sources.svelte.ts`.
 *
 * Nothing in this module throws. Every outcome is a discriminated result, so a
 * view renders a reason instead of a stack trace.
 */

import type { ClientBundle } from "./schema";

export interface RelayBundleRef {
  /** `<peerId>/<file>`, the exact `id` the get route wants. */
  id: string;
  peerId: string;
  size: number;
  createdAt: number;
}

export type RelayFailure =
  /** The operator did not set `TELEMETRY_ADMIN_TOKEN`, so there is no console. */
  | "no-console"
  /** The token was wrong. */
  | "unauthorized"
  | "rate-limited"
  /** The relay refused, or answered a status this client does not expect. */
  | "server"
  /** The body was not the JSON this client expects. */
  | "malformed"
  /** DNS, TLS, CORS or an offline host. */
  | "network"
  /** The form was incomplete, so no request was made. */
  | "input";

export type RelayResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: RelayFailure; message: string };

const MESSAGES: Readonly<Record<RelayFailure, string>> = {
  "no-console":
    "This relay has no telemetry console. The operator did not set TELEMETRY_ADMIN_TOKEN.",
  unauthorized: "The relay refused the admin token.",
  "rate-limited": "The relay rate-limited this client. Wait a minute.",
  server: "The relay answered an unexpected status.",
  malformed: "The relay answered a body this client does not understand.",
  network:
    "The relay is unreachable. Check the host, the scheme and the relay's CORS answer.",
  input: "Give both a relay host and an admin token.",
};

function fail<T>(reason: RelayFailure, extra?: string): RelayResult<T> {
  const base = MESSAGES[reason];
  return { ok: false, reason, message: extra ? `${base} ${extra}` : base };
}

/**
 * Accept `relay.example.com`, `https://relay.example.com` or a trailing slash.
 * A bare host becomes https, because the relay's admin routes are TLS-only in
 * every deployment that has a token at all.
 */
export function normalizeBase(input: string): string {
  const raw = input.trim().replace(/\/+$/, "");
  if (raw === "") return "";
  if (/^https?:\/\//i.test(raw)) return raw;
  return `https://${raw}`;
}

async function get(
  base: string,
  path: string,
  token: string
): Promise<RelayResult<unknown>> {
  const apiBase = normalizeBase(base);
  if (apiBase === "" || token.trim() === "") return fail("input");

  let res: Response;
  try {
    res = await fetch(`${apiBase}${path}`, {
      method: "GET",
      headers: { authorization: `Bearer ${token.trim()}` },
      // No cookies: a bearer token is the only credential this console has.
      credentials: "omit",
    });
  } catch {
    return fail("network");
  }

  if (res.status === 404) return fail("no-console");
  if (res.status === 401 || res.status === 403) return fail("unauthorized");
  if (res.status === 429) return fail("rate-limited");
  if (!res.ok) return fail("server", `Status ${res.status}.`);

  try {
    return { ok: true, value: (await res.json()) as unknown };
  } catch {
    return fail("malformed");
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null;
}

function refOf(v: unknown): RelayBundleRef | null {
  if (!isRecord(v)) return null;
  const { id, peerId, size, createdAt } = v;
  if (typeof id !== "string" || typeof peerId !== "string") return null;
  return {
    id,
    peerId,
    size: typeof size === "number" ? size : 0,
    createdAt: typeof createdAt === "number" ? createdAt : 0,
  };
}

/** `GET /telemetry/list`. Newest first, as the relay returns them. */
export async function listBundles(
  apiBase: string,
  token: string
): Promise<RelayResult<RelayBundleRef[]>> {
  const res = await get(apiBase, "/telemetry/list", token);
  if (!res.ok) return res;
  if (!isRecord(res.value) || !Array.isArray(res.value.bundles)) {
    return fail("malformed");
  }
  const out: RelayBundleRef[] = [];
  for (const entry of res.value.bundles) {
    const ref = refOf(entry);
    if (ref) out.push(ref);
  }
  return { ok: true, value: out };
}

/** `GET /telemetry/get?id=<peerId>/<file>`. */
export async function getBundle(
  apiBase: string,
  token: string,
  id: string
): Promise<RelayResult<ClientBundle>> {
  const res = await get(
    apiBase,
    `/telemetry/get?id=${encodeURIComponent(id)}`,
    token
  );
  if (!res.ok) return res;
  const b = res.value;
  if (!isRecord(b) || b.vantage !== "client" || !Array.isArray(b.events)) {
    return fail("malformed", "It is not a client bundle.");
  }
  return { ok: true, value: b as unknown as ClientBundle };
}
