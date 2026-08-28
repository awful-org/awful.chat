// STUN servers - safe to ship, no credentials.
//
// Two, not seven. Gathering does not finish until every entry has answered or
// timed out, and the extras bought nothing: stun2/3/4.l.google.com are the
// same anycast service as these and return the same reflexive candidate, while
// stun:openrelay.metered.ca and stun:stun.twilio.com have no DNS record at all
// (checked against 8.8.8.8) - every peer connection was waiting on two lookups
// that can only fail.
const STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  // Not stun1.l.google.com: it resolves to the SAME address as the line above
  // (74.125.250.129 when checked), so the pair was one server wearing two
  // names. Cloudflare is a second anycast provider at the same latency, which
  // is what redundancy was supposed to mean.
  { urls: "stun:stun.cloudflare.com:3478" },
];

// No static TURN credentials ship in the bundle any more.
//
// They used to: username "awful", password "awful", readable by anyone who
// opened the JS, which made the server an open relay for the whole internet.
// The people that hurts first are the ones who NEED TURN - mobile and CGNAT
// users, who cannot connect directly - because the relay port range is finite
// and a stranger exhausting it does not slow those users down, it locks them
// out. coturn now runs with --use-auth-secret, so a permanent credential
// could not work even if one were shipped.
//
// TURN now comes only from /turn-credentials (see refreshTurnCredentials),
// which mints a short-lived HMAC per client. Until that answers, the list is
// STUN-only: peers that can connect directly still do, and relayed peers get
// TURN a moment later, on the first refresh.

// ponytail: openrelay.metered.ca was the "last resort" TURN and its domain no
// longer resolves, so all three entries were dead weight on every connection -
// a relay candidate that can never gather, three allocations that can only
// time out. Removed rather than replaced: awful.frav.in is the only TURN we
// control. If a real fallback is wanted, add one host that resolves.
function withTurn(turn: RTCIceServer): RTCIceServer[] {
  return [...STUN_SERVERS, turn];
}

// Current ICE server list. STUN only until refreshTurnCredentials() lands a
// credentialled TURN entry.
let cached: RTCIceServer[] = [...STUN_SERVERS];

/** ICE servers for a new RTCPeerConnection. Read synchronously at PC creation. */
export function getIceServers(): RTCIceServer[] {
  return cached;
}

/**
 * Fetch short-lived TURN credentials from the relay and swap them into the
 * cached ICE list. Best-effort: on any failure (endpoint absent, TURN_SECRET
 * unset → 204, network error, malformed body) the list stays STUN-only, so
 * peers that can connect directly still do and only relayed ones are
 * affected. Cheap to call on every connect, and worth retrying: without it a
 * mobile or CGNAT peer has no path at all.
 */
export async function refreshTurnCredentials(): Promise<void> {
  try {
    const base =
      (import.meta.env.VITE_API_URL as string | undefined) ||
      "https://awful.frav.in";
    const res = await fetch(`${base}/turn-credentials`);
    if (!res.ok) return; // error → stay STUN-only, try again next connect
    // 204 is the relay saying TURN_SECRET is unset. It is a documented,
    // supported state, not a fault - and it is `ok`, so it has to be caught
    // here or it falls through to a JSON parse of an empty body.
    if (res.status === 204) return;
    // A host that answers an unrouted path with index.html returns 200 too, so
    // res.ok is not enough on its own: the JSON parse below would throw into
    // the silent catch and leave the list STUN-only with nothing logged. That
    // is what a deploy without VITE_API_URL looks like.
    if (!res.headers.get("content-type")?.includes("application/json")) {
      console.warn(
        "[ice] /turn-credentials did not return JSON - no TURN available, relayed peers will not connect"
      );
      return;
    }
    const d = (await res.json()) as {
      username?: unknown;
      credential?: unknown;
      urls?: unknown;
    };
    if (
      typeof d?.username !== "string" ||
      typeof d?.credential !== "string" ||
      !Array.isArray(d?.urls) ||
      d.urls.length === 0 ||
      !d.urls.every((u) => typeof u === "string")
    ) {
      return;
    }
    cached = withTurn({
      urls: d.urls as string[],
      username: d.username,
      credential: d.credential,
    });
  } catch {
    // Stay STUN-only. The next connect() calls this again.
  }
}

/**
 * @deprecated Use getIceServers() - this is a snapshot and won't reflect a
 * later credential refresh. Retained for any external import.
 */
export const defaultIceServerList: RTCIceServer[] = cached;
