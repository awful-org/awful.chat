/**
 * Audio settings survive a reload. They live in localStorage rather than
 * IndexedDB because they belong to the device, not the identity: the mic you
 * picked on this machine should not follow you to another one through sync.
 */

const KEY = "awful_audio_prefs";

export interface AudioPrefs {
  inputDevice: string | null;
  outputDevice: string | null;
  inputGain: number;
  outputVolume: number;
  dtlnEnabled: boolean;
  noiseGate: number;
  /**
   * Screen-share audio that could not be confirmed echo-free (see
   * share-audio.ts) is withheld by default - the sharer must opt in here
   * to send it anyway. Device-local and never sent to the room: it is a
   * choice about what THIS device publishes, not room state.
   */
  shareAudioDespiteEchoRisk: boolean;
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
  inputGain: 1.0,
  outputVolume: 1.0,
  dtlnEnabled: true,
  noiseGate: 0.002,
  shareAudioDespiteEchoRisk: false,
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

export function loadAudioPrefs(): AudioPrefs {
  if (typeof localStorage === "undefined") return { ...AUDIO_PREF_DEFAULTS };
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return { ...AUDIO_PREF_DEFAULTS };
    const p = JSON.parse(raw) as Partial<AudioPrefs>;
    return {
      inputDevice: typeof p.inputDevice === "string" ? p.inputDevice : null,
      outputDevice: typeof p.outputDevice === "string" ? p.outputDevice : null,
      inputGain: num(p.inputGain, AUDIO_PREF_DEFAULTS.inputGain, 0, 2.5),
      outputVolume: num(p.outputVolume, AUDIO_PREF_DEFAULTS.outputVolume, 0, 2),
      dtlnEnabled:
        typeof p.dtlnEnabled === "boolean"
          ? p.dtlnEnabled
          : AUDIO_PREF_DEFAULTS.dtlnEnabled,
      noiseGate: num(p.noiseGate, AUDIO_PREF_DEFAULTS.noiseGate, 0, 0.01),
      shareAudioDespiteEchoRisk:
        typeof p.shareAudioDespiteEchoRisk === "boolean"
          ? p.shareAudioDespiteEchoRisk
          : AUDIO_PREF_DEFAULTS.shareAudioDespiteEchoRisk,
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
