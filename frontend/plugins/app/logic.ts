/**
 * Pure logic for Apps: what `/app` accepts, what a card holds, and how the
 * people using it are tracked. Separate from the components so tests run the
 * real reducer. The protocol an app speaks is docs/awful-contract.md.
 */
import type { CardCtx, UpdateCtx } from "$lib/plugins/api";

/** What the starter may pass after the URL (`/app {url} {args}`). */
export const MAX_ARGS = 256;
export const MAX_URL = 2048;
/** A player not heard from in this long has left (a closed tab sends nothing). */
export const PRESENCE_TTL_MS = 45_000;
/** How often a player who has the app open says so. */
export const HEARTBEAT_MS = 15_000;

/** What a card carries: everything an app needs, nothing it may not have. */
export interface AppCardData {
  url: string;
  /** The app's room, handed to it as `session.id`. */
  sessionId: string;
  /** Never sent to the app: salts player ids so the site cannot link them to anyone. */
  salt: string;
  /** What the starter typed after the URL, for the app: `session.args`. */
  args: string;
}

export interface AppState extends AppCardData {
  /** The page's origin, the only one the bridge talks to. "" when the card is unusable. */
  origin: string;
  /** Host-verified: the card's sender, the only one who can end it. */
  starter: string;
  ended: boolean;
  /**
   * Who has the app open, from live (ephemeral) updates only, by DID. Kept
   * with the time this client heard them: ephemerals are never stored or
   * replayed, so reading the clock here costs no client its agreement with
   * another.
   */
  present: Record<string, { name: string; seenAt: number }>;
}

/**
 * The URL an app is opened at: https only, no credentials, bounded. A bare
 * host ("je.frav.in") means https. Null for anything else.
 */
export function parseAppUrl(input: string): URL | null {
  const raw = input.trim();
  if (!raw || raw.length > MAX_URL) return null;
  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:/i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || !url.hostname.includes(".")) return null;
  return url;
}

/** `/app {url} {args}`: the first word is the address, the rest is for the app. */
export function parseAppCommand(input: string): { url: URL; args: string } | null {
  const trimmed = input.trim();
  const space = trimmed.search(/\s/);
  const urlPart = space === -1 ? trimmed : trimmed.slice(0, space);
  const url = parseAppUrl(urlPart);
  if (!url) return null;
  const args = space === -1 ? "" : trimmed.slice(space).trim();
  if (args.length > MAX_ARGS) return null;
  return { url, args };
}

/** 16 random bytes as base64url: session ids and salts. */
export function randomToken(prefix = ""): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return prefix + btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const TOKEN_RE = /^[A-Za-z0-9_-]{8,64}$/;

export function initialState(cardData: unknown, ctx: CardCtx): AppState {
  const d = (cardData ?? {}) as Record<string, unknown>;
  const url = typeof d.url === "string" ? parseAppUrl(d.url) : null;
  const sessionId = typeof d.sessionId === "string" && TOKEN_RE.test(d.sessionId) ? d.sessionId : "";
  const salt = typeof d.salt === "string" && TOKEN_RE.test(d.salt) ? d.salt : "";
  const args = typeof d.args === "string" ? d.args.slice(0, MAX_ARGS) : "";
  const usable = !!url && !!sessionId && !!salt;
  return {
    url: usable ? url!.href : "",
    origin: usable ? url!.origin : "",
    sessionId,
    salt,
    args,
    starter: ctx.senderDid,
    // A card that cannot be opened never takes a tile.
    ended: !usable,
    present: {},
  };
}

/**
 * Presence rides live updates ("join", "here", "leave"); "end" is stored, so
 * it holds in history, and only the starter's counts.
 */
export function reduce(state: AppState, update: { data: unknown }, ctx: UpdateCtx): AppState {
  const data = update.data;
  if (typeof data !== "object" || data === null) return state;
  const t = (data as { t?: unknown }).t;
  if (t === "end") {
    if (ctx.ephemeral || ctx.senderDid !== state.starter || state.ended) return state;
    return { ...state, ended: true, present: {} };
  }
  if (!ctx.ephemeral || state.ended) return state;
  if (t === "join" || t === "here") {
    const name = (ctx.senderName || "").trim().slice(0, 64) || "Someone";
    return { ...state, present: { ...state.present, [ctx.senderDid]: { name, seenAt: Date.now() } } };
  }
  if (t === "leave") {
    if (!(ctx.senderDid in state.present)) return state;
    const present = { ...state.present };
    delete present[ctx.senderDid];
    return { ...state, present };
  }
  return state;
}

/** The people heard from recently, oldest first. */
export function presentPlayers(state: AppState, now = Date.now()): Array<{ did: string; name: string }> {
  return Object.entries(state.present)
    .filter(([, p]) => now - p.seenAt < PRESENCE_TTL_MS)
    .sort((a, b) => a[1].seenAt - b[1].seenAt)
    .map(([did, p]) => ({ did, name: p.name }));
}

/**
 * A player's id for the app: the same for everyone in this session, and
 * meaningless anywhere else. HMAC over the session and the DID, keyed by the
 * card's salt, which the app never receives - so the site can neither link
 * the id to a person nor match it with the same person's id elsewhere.
 */
export async function playerId(salt: string, sessionId: string, did: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey("raw", enc.encode(salt), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, enc.encode(`${sessionId}\n${did}`)));
  let s = "";
  for (const b of mac.slice(0, 12)) s += String.fromCharCode(b);
  return "p_" + btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
