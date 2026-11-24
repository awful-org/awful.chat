import { parseJoinInput } from "$lib/invite";
import { normalizeRoomCode } from "$lib/room-code";
import { parseSecureInvitation } from "$lib/room-security/invitation-format";
import { DISCOVERY_ID_RE, b32 } from "$lib/room-security/keys";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";

/**
 * The room this tab was opened for, once read out of the address bar and
 * until its join has run. Outside any component's state: a remembered
 * password unlocks by raising identityStore.initializing, which swaps the
 * app for the spinner and back - a fresh instance - and the address bar
 * was already cleared, so the invitation was simply gone: the tab showed
 * the room list, "Connecting...", and never joined or took the node.
 *
 * Here rather than in AppView because the setup and unlock screens come
 * first and AppView only loads once they are done (IdentityGate.svelte):
 * they take the code out of the address bar, AppView joins it.
 */
export const parkedRoom = {
  get code(): string | null {
    return parked ?? (parked = readParked());
  },
  set code(code: string | null) {
    parked = code;
    writeParked(code);
  },
};

let parked: string | null = null;

/*
 * An invitation also outlives a reload of the page it opened, in this tab's
 * sessionStorage, until its join has run. Memory alone lost it: a phone drops
 * a page left for another app - to put the recovery phrase somewhere, say -
 * and what came back was an app that had never heard of the room.
 *
 * Only a reload: the address it leaves is /r/, and any other address is the
 * user having gone elsewhere, which calls the invitation off. A saved room's
 * public id is never kept: that one stays in the address.
 *
 * Sealed under a key in localStorage, because a wipe reaches that and not a
 * tab the phone has dropped: without the key what such a tab holds is noise,
 * and it comes back with nothing. forgetParkedRooms is the same for the ways
 * of removing an account that leave localStorage alone.
 */
const PARKED_KEY = "awful:parked-invitation:v1";
const SEAL_KEY = "awful:parked-key:v1";
/** For DM places below. The account's: it goes with it (identity.ts). */
export const PLACE_KEY = "awful:place-key:v1";

function readParked(): string | null {
  try {
    const held = sessionStorage.getItem(PARKED_KEY);
    if (!held) return null;
    const code = /^\/r\/?$/.test(window.location.pathname) ? unsealInvitation(held) : null;
    if (!code) sessionStorage.removeItem(PARKED_KEY);
    return code;
  } catch {
    return null;
  }
}

function writeParked(code: string | null): void {
  try {
    if (code && !DISCOVERY_ID_RE.test(code) && parseJoinInput(code).kind !== "invalid") {
      sessionStorage.setItem(PARKED_KEY, seal(code));
    } else sessionStorage.removeItem(PARKED_KEY);
  } catch {
    // No storage to be had: memory is what there is.
  }
}

/** No tab finds its parked invitation, or a DM it was on, again. */
export function forgetParkedRooms(): void {
  parkedRoom.code = null;
  try {
    localStorage.removeItem(SEAL_KEY);
  } catch {
    // Nothing is kept without storage.
  }
  forgetPlaces();
}

/** No tab finds a DM it was on again; a parked invitation stays. */
export function forgetPlaces(): void {
  try {
    localStorage.removeItem(PLACE_KEY);
  } catch {
    // Nothing is kept without storage.
  }
}

/** The bytes a nonce stands for under the key; null with no key. */
function keystream(name: string, nonce: Uint8Array, length: number): Uint8Array | null {
  const key = localStorage.getItem(name);
  return key ? hkdf(sha256, b32.decode(key), nonce, undefined, length) : null;
}

function seal(code: string, key = SEAL_KEY): string {
  if (!localStorage.getItem(key)) {
    localStorage.setItem(key, b32.encode(crypto.getRandomValues(new Uint8Array(32))));
  }
  const nonce = crypto.getRandomValues(new Uint8Array(16));
  const bytes = new TextEncoder().encode(code);
  const stream = keystream(key, nonce, bytes.length)!;
  return `${b32.encode(nonce)}.${b32.encode(bytes.map((b, i) => b ^ stream[i]))}`;
}

/** What was sealed, if it is an invitation; noise under another key is not. */
function unsealInvitation(held: string): string | null {
  const code = unseal(held);
  return !code || parseJoinInput(code).kind === "invalid" ? null : code;
}

function unseal(held: string, key = SEAL_KEY): string | null {
  const [nonce, sealed] = held.split(".").map((part) => b32.decode(part));
  const stream = keystream(key, nonce, sealed.length);
  if (!stream) return null;
  return new TextDecoder().decode(sealed.map((b, i) => b ^ stream[i]));
}

/*
 * Which place an entry of the tab's history stands for, for a reload and for
 * going back. A room is in the address already, as its public id, and the
 * channel open in it goes in the entry. A DM has no address: one would leave
 * whom you write to in the browser's history, where a wipe does not reach. It
 * is in the entry alone, sealed like a parked invitation.
 */

/** The history entry for a DM conversation. */
export function dmPlace(roomCode: string): { dm?: string } {
  try {
    return { dm: seal(roomCode, PLACE_KEY) };
  } catch {
    return {}; // No storage for the key: a reload shows the start screen.
  }
}

/** The DM conversation this history entry stands for. */
export function dmOfPlace(state: { dm?: unknown } | null = history.state): string | null {
  try {
    const held = state?.dm;
    const code = typeof held === "string" ? unseal(held, PLACE_KEY) : null;
    return code?.startsWith("dm-") ? code : null;
  } catch {
    return null;
  }
}

/** The channel this history entry has open in a room ("" is its main chat);
    null when the entry is not one for that room. */
export function channelOfPlace(roomCode: string): string | null {
  const state = history.state;
  if (state?.roomCode !== roomCode) return null;
  return typeof state.channel === "string" ? state.channel : "";
}

/** The channel open in a room, on the entry that stands for it. */
export function noteChannel(roomCode: string, channel: string): void {
  const state = history.state;
  if (state?.roomCode !== roomCode || (state.channel ?? "") === channel) return;
  history.replaceState({ ...state, channel }, "");
}

/**
 * Show a place in the address bar. The place the entry stands for already
 * takes no new one: a reload, or going back to it, would add its own.
 */
export function showPlace(state: { roomCode?: string; channel?: string; dm?: string }, url: string): void {
  const here = window.location.pathname + window.location.hash;
  if (here === url && dmOfPlace(state) === dmOfPlace()) history.replaceState(state, "", url);
  else history.pushState(state, "", url);
}

/**
 * The room code out of the address bar, fragment form first.
 *
 * The code IS the membership secret, so it lives in `/r/#<code>` - a
 * fragment is never sent to the server, never lands in an access log and
 * never rides a Referer. `/r/<code>` still parses: links already handed out
 * do not change, and App.svelte rewrites one to the fragment on load.
 */
function parseRoomCode(pathname: string, hash: string): string | null {
  // `/r#<code>` too: some apps drop the slash before the #.
  if (pathname === "/r") pathname = "/r/";
  if (!pathname.startsWith("/r/")) return null;
  const raw =
    hash.length > 1 ? hash.slice(1) : pathname.slice(3).split("/")[0];
  if (!raw) return null;
  try {
    try { return parseSecureInvitation(pathname + hash); } catch { /* Stored room navigation. */ }
    // A short link, `/r/#k5t-8r5`: handleJoin redeems it like a typed code.
    // Or an invitation with what followed it in a message: `#r2_….`
    const parsed = parseJoinInput(decodeURIComponent(raw));
    if (parsed.kind !== "invalid") return parsed.code;
    return normalizeRoomCode(decodeURIComponent(raw));
  } catch {
    return normalizeRoomCode(raw);
  }
}

/** The room code in the address bar, taken out of it unless it is public. */
export function consumeRoomLocation(): string | null {
  const code = parseRoomCode(window.location.pathname, window.location.hash);
  // Keep incoming capabilities out of the address, even while identity is locked.
  // Public saved-room IDs are safe to retain for reload/navigation. Strip
  // malformed inputs too: they can contain a truncated or wrapped secret.
  if (code && !DISCOVERY_ID_RE.test(code)) {
    history.replaceState(history.state, "", "/r/");
  }
  return code;
}
