import { parseJoinInput } from "$lib/invite";
import { normalizeRoomCode } from "$lib/room-code";
import { parseSecureInvitation } from "$lib/room-security/invitation-format";
import { DISCOVERY_ID_RE } from "$lib/room-security/keys";

/**
 * The room this tab was opened for, once read out of the address bar and
 * until its join has run. Module-level, not component state: a remembered
 * password unlocks by raising identityStore.initializing, which swaps the
 * app for the spinner and back - a fresh instance - and the address bar
 * was already cleared, so the invitation was simply gone: the tab showed
 * the room list, "Connecting...", and never joined or took the node.
 *
 * Here rather than in AppView because the setup and unlock screens come
 * first and AppView only loads once they are done (IdentityGate.svelte):
 * they take the code out of the address bar, AppView joins it.
 */
export const parkedRoom: { code: string | null } = { code: null };

/**
 * The room code out of the address bar, fragment form first.
 *
 * The code IS the membership secret, so it lives in `/r/#<code>` - a
 * fragment is never sent to the server, never lands in an access log and
 * never rides a Referer. `/r/<code>` still parses: links already handed out
 * do not change, and App.svelte rewrites one to the fragment on load.
 */
function parseRoomCode(pathname: string, hash: string): string | null {
  if (!pathname.startsWith("/r/")) return null;
  const raw =
    hash.length > 1 ? hash.slice(1) : pathname.slice(3).split("/")[0];
  if (!raw) return null;
  try {
    try { return parseSecureInvitation(pathname + hash); } catch { /* Stored room navigation. */ }
    // A short link, `/r/#k5t-8r5`: handleJoin redeems it like a typed code.
    const pairing = parseJoinInput(decodeURIComponent(raw));
    if (pairing.kind === "pairing") return pairing.code;
    return normalizeRoomCode(decodeURIComponent(raw));
  } catch {
    return normalizeRoomCode(raw);
  }
}

/** The room code in the address bar, taken out of it unless it is public. */
export function consumeRoomLocation(): string | null {
  const code = parseRoomCode(window.location.pathname, window.location.hash);
  // Keep incoming capabilities only in memory, even while identity is locked.
  // Public saved-room IDs are safe to retain for reload/navigation. Strip
  // malformed inputs too: they can contain a truncated or wrapped secret.
  if (code && !DISCOVERY_ID_RE.test(code)) {
    history.replaceState(history.state, "", "/r/");
  }
  return code;
}
