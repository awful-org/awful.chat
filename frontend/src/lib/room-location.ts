import { parseJoinInput } from "$lib/invite";
import { normalizeRoomCode } from "$lib/room-code";
import { parseSecureInvitation } from "$lib/room-security/invitation-format";
import { DISCOVERY_ID_RE } from "$lib/room-security/keys";

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
 * An invitation also outlives a reload, in this tab's sessionStorage, until
 * its join has run. Memory alone lost it: a phone drops a page left for
 * another app - to put the recovery phrase somewhere, say - and what came
 * back was an app that had never heard of the room. The tab's own storage
 * dies with the tab, and the link it holds was this tab's address a moment
 * before. Never a saved room's public id: that one stays in the address.
 */
const PARKED_KEY = "awful:parked-invitation:v1";

function readParked(): string | null {
  try {
    return sessionStorage.getItem(PARKED_KEY);
  } catch {
    return null;
  }
}

function writeParked(code: string | null): void {
  try {
    if (code && !DISCOVERY_ID_RE.test(code) && parseJoinInput(code).kind !== "invalid") {
      sessionStorage.setItem(PARKED_KEY, code);
    } else sessionStorage.removeItem(PARKED_KEY);
  } catch {
    // No storage to be had: memory is what there is.
  }
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
