import { expect, it } from "vitest";
import { voiceDiagnosticsView, type VoiceDiagnostics } from "./voice-diagnostics";

const sample: VoiceDiagnostics = {
  sampledAt: 1000, route: "relay", rttMs: 84, lastAudioAt: 1000,
  connectionState: "connected", iceState: "completed",
};
it("distinguishes live TURN from outdated evidence", () => {
  expect(voiceDiagnosticsView(sample, 3000)).toMatchObject({
    route: "TURN relay", latency: "84 ms", audio: "Receiving data", ageSeconds: 2, stale: false,
  });
  expect(voiceDiagnosticsView(sample, 14000)).toMatchObject({
    route: "Unknown", latency: "Unavailable", audio: "Not verified", stale: true,
  });
});
it("does not claim media is flowing just because the last sample is fresh", () => {
  expect(voiceDiagnosticsView({ ...sample, sampledAt: 10000 }, 11000).audio).toBe("No recent data");
  expect(voiceDiagnosticsView({ ...sample, lastAudioAt: null }, 3000).audio).toBe("Not verified");
});
it("does not present a disconnected link or missing stats as healthy", () => {
  expect(voiceDiagnosticsView({ ...sample, connectionState: "disconnected" }, 3000).route).toBe("Unknown");
  expect(voiceDiagnosticsView(null, 3000)).toMatchObject({ route: "Unknown", ageSeconds: null, audio: "Not verified" });
});
