// STUN servers - safe to ship, no credentials.
const STUN_SERVERS: RTCIceServer[] = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
  { urls: "stun:stun2.l.google.com:19302" },
  { urls: "stun:stun3.l.google.com:19302" },
  { urls: "stun:stun4.l.google.com:19302" },
  { urls: "stun:openrelay.metered.ca:80" },
  { urls: "stun:stun.twilio.com:3478" },
];

// Static TURN for awful.frav.in - only a FALLBACK, used until the relay hands
// out short-lived HMAC credentials (see refreshTurnCredentials). Shipping a
// permanent shared secret lets anyone relay through the server, so the relay's
// /turn-credentials endpoint (coturn use-auth-secret) supersedes this whenever
// TURN_SECRET is configured.
const STATIC_TURN: RTCIceServer = {
  urls: [
    "turn:awful.frav.in:3478?transport=udp",
    "turn:awful.frav.in:3478?transport=tcp",
    "turn:awful.frav.in:5349?transport=tcp",
    // TLS is what restrictive mobile carriers still allow; skipped harmlessly
    // until coturn is given a certificate.
    "turns:awful.frav.in:5349?transport=tcp",
  ],
  username: "awful",
  credential: "awful",
};

// Free public TURN fallback (rate-limited) - kept in all cases as a last resort.
const FALLBACK_TURN: RTCIceServer[] = [
  {
    urls: "turn:openrelay.metered.ca:80",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
  {
    urls: "turn:openrelay.metered.ca:443?transport=tcp",
    username: "openrelayproject",
    credential: "openrelayproject",
  },
];

function withTurn(turn: RTCIceServer): RTCIceServer[] {
  return [...STUN_SERVERS, turn, ...FALLBACK_TURN];
}

// Current ICE server list. Starts with the static TURN fallback and is upgraded
// in place to short-lived credentials once refreshTurnCredentials() succeeds.
let cached: RTCIceServer[] = withTurn(STATIC_TURN);

/** ICE servers for a new RTCPeerConnection. Read synchronously at PC creation. */
export function getIceServers(): RTCIceServer[] {
  return cached;
}

/**
 * Fetch short-lived TURN credentials from the relay and swap them into the
 * cached ICE list. Best-effort: on any failure (endpoint absent, TURN_SECRET
 * unset → 204, network error, malformed body) the static fallback stays in
 * place so calls/transfers keep working. Cheap to call on every connect.
 */
export async function refreshTurnCredentials(): Promise<void> {
  try {
    const base =
      (import.meta.env.VITE_API_URL as string | undefined) ||
      "https://awful.frav.in";
    const res = await fetch(`${base}/turn-credentials`);
    if (!res.ok) return; // 204 (not configured) or error → keep fallback
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
    // keep the static fallback
  }
}

/**
 * @deprecated Use getIceServers() - this is a snapshot and won't reflect a
 * later credential refresh. Retained for any external import.
 */
export const defaultIceServerList: RTCIceServer[] = cached;
