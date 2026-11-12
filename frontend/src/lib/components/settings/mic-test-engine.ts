import { dfnUnsupportedReason } from "$lib/audio/dfn-processor";
import type { MicDenoiser } from "$lib/audio/dtln-processor";
import {
  NOISE_ENGINE_LABELS,
  noiseEngineOrder,
  type NoiseEngine,
} from "$lib/transport/audio-prefs";

/**
 * The model a mic test plays through, picked the way a call picks one (see
 * LibP2PVoice.startMic): `wanted` first, then DTLN, skipping DeepFilterNet3
 * where it cannot run and any model that does not get ready. A null engine
 * is the browser's own suppression. `notice` says what the test fell back
 * from and why, or is null when it runs what was wanted.
 */
export async function pickMicTestEngine(
  wanted: NoiseEngine | "browser",
  hardwareRate: number,
  denoisers: Record<NoiseEngine, MicDenoiser>
): Promise<{ engine: NoiseEngine | null; notice: string | null }> {
  const missed: string[] = [];
  const picked = (engine: NoiseEngine | null) => ({
    engine,
    notice: missed.length
      ? `${missed.join(" and ")}, so this test uses ${
          engine ? NOISE_ENGINE_LABELS[engine] : "browser noise suppression"
        }.`
      : null,
  });
  for (const engine of wanted === "browser" ? [] : noiseEngineOrder(wanted)) {
    const label = NOISE_ENGINE_LABELS[engine];
    const unsupported = engine === "dfn3" ? dfnUnsupportedReason(hardwareRate) : null;
    if (unsupported) {
      missed.push(`${label} can't run on this device (${unsupported})`);
      continue;
    }
    try {
      await denoisers[engine].waitUntilReady();
      return picked(engine);
    } catch (err) {
      console.error(`[mic test] ${label} failed:`, err);
      missed.push(`${label} couldn't start`);
    }
  }
  return picked(null);
}
