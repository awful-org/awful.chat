/**
 * Media-device settings survive a reload. They live in localStorage rather
 * than IndexedDB because they belong to the device, not the identity: the mic
 * you picked on this machine should not follow you to another one through
 * sync.
 *
 * The camera lives here too, despite the file's name. It is the same kind of
 * setting with the same lifetime, and a second store with identical mechanics
 * would buy nothing; the localStorage key stays as it is so nobody's existing
 * audio settings are lost to a rename.
 */

const KEY = "awful_audio_prefs";

export const SHARE_HEIGHTS = [0, 720, 1080] as const;
export const SHARE_FPS = [15, 30, 60] as const;
export const SHARE_CONTENT_HINTS = ["", "motion", "detail"] as const;
export type ShareContentHint = (typeof SHARE_CONTENT_HINTS)[number];
export type ShareHeight = (typeof SHARE_HEIGHTS)[number];
export type ShareFps = (typeof SHARE_FPS)[number];
/** The noise-suppression models: DeepFilterNet3 and DTLN. */
export const NOISE_ENGINES = ["dfn3", "dtln"] as const;
export type NoiseEngine = (typeof NOISE_ENGINES)[number];
/** What the user sees each one called, and the browser's own suppression. */
export const NOISE_ENGINE_LABELS: Record<NoiseEngine | "browser", string> = {
  dfn3: "DeepFilterNet",
  dtln: "DTLN",
  browser: "Browser",
};

/**
 * The models to try for a preferred one, best first: DTLN backs DeepFilterNet3
 * up, and only the browser backs DTLN up. A call (LibP2PVoice) and the mic
 * test (mic-test-engine.ts) both walk it.
 */
export function noiseEngineOrder(preferred: NoiseEngine): NoiseEngine[] {
  return preferred === "dfn3" ? ["dfn3", "dtln"] : ["dtln"];
}

export interface AudioPrefs {
  inputDevice: string | null;
  outputDevice: string | null;
  /**
   * deviceId of the camera to ask for, or null for whatever the browser
   * calls default. A device that has since gone away is not an error: the
   * constraint is `ideal`, so getUserMedia falls back rather than failing.
   */
  cameraDevice: string | null;
  inputGain: number;
  outputVolume: number;
  /**
   * Noise suppression on or off, whichever model does it. The name is from
   * when DTLN was the only one, kept so nobody's saved choice is lost.
   */
  dtlnEnabled: boolean;
  /**
   * The model to use while noise suppression is on. A failing model falls
   * back for the rest of that call only, and never rewrites this.
   */
  noiseEngine: NoiseEngine;
  /** DTLN's gate threshold; DeepFilterNet3 gates by itself. */
  noiseGate: number;
  /**
   * DeepFilterNet3's strength, in dB: the most it removes while you speak,
   * and how far noise is pushed down in pauses. Applied live (see
   * DfnProcessor.setAttenuation); kept in range by clampDfnAttenuation.
   */
  dfnSpeechAttenuationDb: number;
  dfnPauseAttenuationDb: number;
  /**
   * Screen-share audio that could not be confirmed echo-free (see
   * share-audio.ts) is withheld by default - the sharer must opt in here
   * to send it anyway. Device-local and never sent to the room: it is a
   * choice about what THIS device publishes, not room state.
   */
  shareAudioDespiteEchoRisk: boolean;
  /**
   * Screen-share quality, Discord-style: the tallest frame to capture (0 =
   * whatever the source is) and the frame rate to ask for. Device-local:
   * it is about this uplink, not the room.
   */
  shareHeight: ShareHeight;
  shareFps: ShareFps;
  shareContentHint: ShareContentHint;
  /**
   * How loud each person is for us, keyed by their did:key - the durable
   * identity, so the setting survives them reinstalling or changing devices,
   * where a peerId would not.
   */
  peerVolumes: Record<string, number>;
}

export const AUDIO_PREF_DEFAULTS: AudioPrefs = {
  inputDevice: null,
  outputDevice: null,
  cameraDevice: null,
  inputGain: 1.0,
  outputVolume: 1.0,
  dtlnEnabled: true,
  noiseEngine: "dfn3",
  noiseGate: 0.002,
  // The package's own defaults.
  dfnSpeechAttenuationDb: 25,
  dfnPauseAttenuationDb: 45,
  shareAudioDespiteEchoRisk: false,
  shareHeight: 0,
  shareFps: 30,
  shareContentHint: "",
  peerVolumes: {},
};

/** Same ceiling as the per-person slider. */
const MAX_PEER_VOLUME = 2.5;
/** Bound the map: an old public-room habit must not grow it forever. */
const MAX_PEER_VOLUME_ENTRIES = 200;

function sanitizePeerVolumes(value: unknown): Record<string, number> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, number> = {};
  for (const [did, vol] of Object.entries(value as Record<string, unknown>)) {
    if (!did.startsWith("did:")) continue;
    if (typeof vol !== "number" || !Number.isFinite(vol)) continue;
    out[did] = Math.max(0, Math.min(MAX_PEER_VOLUME, vol));
    if (Object.keys(out).length >= MAX_PEER_VOLUME_ENTRIES) break;
  }
  return out;
}

function num(value: unknown, fallback: number, min: number, max: number) {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

/**
 * Pauses always get at least this much more than speech. The package builds
 * its pause gate only when they do, and the gate is fixed at creation - with
 * its 30 ms of delay - so a node must never be made without one.
 */
const DFN_PAUSE_MARGIN_DB = 3;
export const DFN_SPEECH_DB = { min: 6, max: 40 };
export const DFN_PAUSE_DB = { min: DFN_SPEECH_DB.min + DFN_PAUSE_MARGIN_DB, max: 60 };

/**
 * The one place DeepFilterNet3's two strengths are kept in range and in
 * order: speech within DFN_SPEECH_DB, pauses above speech by the margin.
 * Moving speech past pauses pushes pauses up with it.
 */
export function clampDfnAttenuation(
  speechDb: number,
  pauseDb: number
): { speechDb: number; pauseDb: number } {
  const speech = num(
    speechDb, AUDIO_PREF_DEFAULTS.dfnSpeechAttenuationDb, DFN_SPEECH_DB.min, DFN_SPEECH_DB.max
  );
  return {
    speechDb: speech,
    pauseDb: num(
      pauseDb, AUDIO_PREF_DEFAULTS.dfnPauseAttenuationDb, speech + DFN_PAUSE_MARGIN_DB, DFN_PAUSE_DB.max
    ),
  };
}

function oneOf<T extends number | string>(
  allowed: readonly T[],
  value: unknown,
  fallback: T
): T {
  return (allowed as readonly unknown[]).includes(value)
    ? (value as T)
    : fallback;
}

export function loadAudioPrefs(): AudioPrefs {
  if (typeof localStorage === "undefined") return { ...AUDIO_PREF_DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...AUDIO_PREF_DEFAULTS };
    const p = JSON.parse(raw) as Partial<AudioPrefs>;
    const dfn = clampDfnAttenuation(
      p.dfnSpeechAttenuationDb as number,
      p.dfnPauseAttenuationDb as number
    );
    return {
      inputDevice: typeof p.inputDevice === "string" ? p.inputDevice : null,
      outputDevice: typeof p.outputDevice === "string" ? p.outputDevice : null,
      cameraDevice: typeof p.cameraDevice === "string" ? p.cameraDevice : null,
      inputGain: num(p.inputGain, AUDIO_PREF_DEFAULTS.inputGain, 0, 2.5),
      outputVolume: num(p.outputVolume, AUDIO_PREF_DEFAULTS.outputVolume, 0, 2),
      dtlnEnabled:
        typeof p.dtlnEnabled === "boolean"
          ? p.dtlnEnabled
          : AUDIO_PREF_DEFAULTS.dtlnEnabled,
      noiseEngine: oneOf(NOISE_ENGINES, p.noiseEngine, AUDIO_PREF_DEFAULTS.noiseEngine),
      noiseGate: num(p.noiseGate, AUDIO_PREF_DEFAULTS.noiseGate, 0, 0.01),
      dfnSpeechAttenuationDb: dfn.speechDb,
      dfnPauseAttenuationDb: dfn.pauseDb,
      shareAudioDespiteEchoRisk:
        typeof p.shareAudioDespiteEchoRisk === "boolean"
          ? p.shareAudioDespiteEchoRisk
          : AUDIO_PREF_DEFAULTS.shareAudioDespiteEchoRisk,
      shareHeight: oneOf(
        SHARE_HEIGHTS,
        p.shareHeight,
        AUDIO_PREF_DEFAULTS.shareHeight
      ),
      shareFps: oneOf(SHARE_FPS, p.shareFps, AUDIO_PREF_DEFAULTS.shareFps),
      shareContentHint: oneOf(
        SHARE_CONTENT_HINTS, p.shareContentHint, AUDIO_PREF_DEFAULTS.shareContentHint
      ),
      peerVolumes: sanitizePeerVolumes(p.peerVolumes),
    };
  } catch {
    return { ...AUDIO_PREF_DEFAULTS };
  }
}

export function saveAudioPrefs(patch: Partial<AudioPrefs>): void {
  if (typeof localStorage === "undefined") return;
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadAudioPrefs(), ...patch }));
  } catch {
    // Storage full or blocked: settings just do not persist this time.
  }
}

/** Remember how loud one person should be, by their durable identity. */
export function savePeerVolume(did: string, volume: number): void {
  if (!did.startsWith("did:")) return;
  const prefs = loadAudioPrefs();
  const peerVolumes = { ...prefs.peerVolumes };
  // 1 is the default: storing it would only grow the map with no-ops.
  if (Math.abs(volume - 1) < 1e-6) delete peerVolumes[did];
  else peerVolumes[did] = volume;
  saveAudioPrefs({ peerVolumes });
}

export function loadPeerVolume(did: string): number | null {
  const stored = loadAudioPrefs().peerVolumes[did];
  return typeof stored === "number" ? stored : null;
}
