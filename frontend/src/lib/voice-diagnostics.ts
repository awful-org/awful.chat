/** A snapshot of browser measurements, never inferred from a tile's label. */
export interface VoiceDiagnostics {
  sampledAt: number;
  route: "direct" | "relay" | "unknown";
  rttMs: number | null;
  lastAudioAt: number | null;
  connectionState: RTCPeerConnectionState;
  iceState: RTCIceConnectionState;
}

export const VOICE_STATS_STALE_MS = 12_000;
export function voiceDiagnosticsView(sample: VoiceDiagnostics | null, now: number) {
  const ageMs = sample ? Math.max(0, now - sample.sampledAt) : null;
  const stale = ageMs !== null && ageMs >= VOICE_STATS_STALE_MS;
  const connected = sample?.connectionState === "connected";
  return {
    stale,
    ageSeconds: ageMs === null ? null : Math.floor(ageMs / 1000),
    route: !sample || stale || !connected ? "Unknown" :
      sample.route === "relay" ? "TURN relay" : sample.route === "direct" ? "Direct (P2P)" : "Unknown",
    latency: !sample || stale || !connected || sample.rttMs === null ? "Unavailable" : `${sample.rttMs} ms`,
    audio: !sample || stale || !connected || sample.lastAudioAt === null ? "Not verified" :
      now - sample.lastAudioAt < 8_000 ? "Receiving data" : "No recent data",
  };
}
