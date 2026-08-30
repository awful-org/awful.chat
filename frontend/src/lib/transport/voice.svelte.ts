import { transportState, _transport } from "./transport.svelte";
import {
  loadAudioPrefs,
  loadPeerVolume,
  saveAudioPrefs,
  savePeerVolume,
} from "./audio-prefs";
import { peerIdToDid } from "./transport.svelte";
import { looksLikeDid } from "$lib/identity/identity-utils";
import type { LibP2PVoice } from "./libp2p/voice";
import type { DtlnProcessor } from "../audio/dtln-processor";

let _voice: LibP2PVoice | null = null;
let _dtln: DtlnProcessor | null = null;
let _initialized = false;

// Parked volumes: peerId -> { volume, timestamp }
// Stores volumes that couldn't be saved immediately because the DID wasn't resolved yet.
let _parkedVolumes: Map<string, { volume: number; timestamp: number }> = new Map();
let _retryInterval: ReturnType<typeof setInterval> | null = null;

export function initVoice(voice: LibP2PVoice, dtln: DtlnProcessor): void {
  if (_initialized) return;
  _initialized = true;
  _voice = voice;
  _dtln = dtln;

  _voice.on("trackAdded", (peerId, track) => {
    // Apply the remembered volume for this identity the moment audio exists;
    // a manual change during the call still wins (it also updates storage).
    // RETRY while the did binding lands: voice ICE routinely beats the
    // profile exchange, and giving up on the first miss left the live gain
    // at 1.0 while the menu showed the stored boost - a slider already "at"
    // 250% that audibly did nothing.
    const applyStored = (attempt: number) => {
      if (_voice?.hasPeerVolume(peerId)) return;
      const did = peerIdToDid(peerId);
      if (looksLikeDid(did)) {
        const stored = loadPeerVolume(did);
        if (stored !== null) _voice?.setPeerVolume(peerId, stored);
        return;
      }
      if (attempt < 10) setTimeout(() => applyStored(attempt + 1), 1000);
    };
    applyStored(0);
    const existing = transportState.participants.get(peerId) ?? {
      peerId,
      audioTrack: null,
      videoTrack: null,
      screenTrack: null,
      screenAudioTrack: null,
      videoStalled: false,
      screenStalled: false,
    };
    transportState.participants = new Map(transportState.participants).set(
      peerId,
      {
        ...existing,
        audioTrack: track,
      }
    );
  });

  _voice.on("trackRemoved", (peerId) => {
    const p = transportState.participants.get(peerId);
    if (!p) return;
    transportState.participants = new Map(transportState.participants).set(
      peerId,
      {
        ...p,
        audioTrack: null,
      }
    );
  });

  _voice.on("peerLeft", (peerId) => {
    const p = transportState.participants.get(peerId);
    if (!p) return;
    transportState.participants = new Map(transportState.participants).set(
      peerId,
      {
        ...p,
        audioTrack: null,
      }
    );
  });

  _voice.on("error", (err) => {
    transportState.error = err.message;
  });

  // voice.ts's own status statuses (voice-peer-left, voice-connection-
  // failed, voice-degraded, voice-dial-failed, voice-ice-connected) reach
  // nobody without this: they fire on LibP2PVoice's own handler map, and
  // TransportStatus.svelte/CallStatus.svelte/VoiceVideoCallView.svelte all
  // listen on _transport's "status" stream instead (finding 8).
  _voice.on("status", (status) => {
    _transport.announce(status);
  });

  restoreVoicePrefs();
}

function startParkedVolumeRetry(): void {
  if (_retryInterval !== null) return;

  _retryInterval = setInterval(() => {
    if (_parkedVolumes.size === 0) {
      if (_retryInterval !== null) {
        clearInterval(_retryInterval);
      }
      _retryInterval = null;
      return;
    }

    const now = Date.now();
    const deadline = 2 * 60 * 1000;

    for (const [peerId, entry] of _parkedVolumes.entries()) {
      if (now - entry.timestamp > deadline) {
        _parkedVolumes.delete(peerId);
        continue;
      }

      const did = peerIdToDid(peerId);
      if (looksLikeDid(did)) {
        savePeerVolume(did, entry.volume);
        _parkedVolumes.delete(peerId);
      }
    }

    if (_parkedVolumes.size === 0) {
      if (_retryInterval !== null) {
        clearInterval(_retryInterval);
      }
      _retryInterval = null;
    }
  }, 2000);
}

/**
 * Re-apply the settings from the last session. Safe to run before any call:
 * with no AudioContext yet these setters only record the preference, so
 * nothing here asks for microphone access.
 */
function restoreVoicePrefs(): void {
  const prefs = loadAudioPrefs();
  const voice = getVoice();
  voice.setInputGain(prefs.inputGain);
  voice.setOutputVolume(prefs.outputVolume);
  void voice.setDtlnEnabled(prefs.dtlnEnabled);
  getDtln().setNoiseGate(prefs.noiseGate);
  if (prefs.inputDevice) voice.setInputDevice(prefs.inputDevice);
  if (prefs.outputDevice) voice.setOutputDevice(prefs.outputDevice);
}

function getVoice(): LibP2PVoice {
  if (!_voice)
    throw new Error("Voice not initialized. Call initVoice() first.");
  return _voice;
}

function getDtln(): DtlnProcessor {
  if (!_dtln) throw new Error("DTLN not initialized. Call initVoice() first.");
  return _dtln;
}

export async function setVoiceInputDevice(deviceId: string): Promise<void> {
  saveAudioPrefs({ inputDevice: deviceId || null });
  await getVoice().setInputDevice(deviceId);
  transportState.localMicStream = getVoice().getMicStream();
}

export function getVoiceInputDevices(): Promise<MediaDeviceInfo[]> {
  return getVoice().getInputDevices();
}

export function getVoiceActiveInputDevice(): string | null {
  return getVoice().getActiveInputDevice();
}

export function setVoiceInputGain(gain: number): void {
  saveAudioPrefs({ inputGain: gain });
  getVoice().setInputGain(gain);
}
export function getVoiceInputGain(): number {
  return getVoice().getInputGain();
}

export async function setVoiceOutputDevice(deviceId: string): Promise<void> {
  saveAudioPrefs({ outputDevice: deviceId || null });
  await getVoice().setOutputDevice(deviceId);
}

export function getVoiceOutputDevices(): Promise<MediaDeviceInfo[]> {
  return getVoice().getOutputDevices();
}

export function getVoiceActiveOutputDevice(): string | null {
  return getVoice().getActiveOutputDevice();
}

export function setVoiceOutputVolume(volume: number): void {
  const next = Math.max(0, volume);
  saveAudioPrefs({ outputVolume: next });
  if (!transportState.deafened) getVoice().setOutputVolume(next);
}

export function getVoiceOutputVolume(): number {
  return getVoice().getOutputVolume();
}

/** Per-peer listening volume. Local to this device and this call. */
export function setVoicePeerVolume(peerId: string, volume: number): void {
  getVoice().setPeerVolume(peerId, volume);
  // Durable, by identity: nobody wants to re-set a friend's volume every call.
  const did = peerIdToDid(peerId);
  if (looksLikeDid(did)) {
    savePeerVolume(did, volume);
  } else {
    _parkedVolumes.set(peerId, { volume, timestamp: Date.now() });
    startParkedVolumeRetry();
  }
}

export function getVoicePeerVolume(peerId: string): number {
  // The live value once one exists; before the first track (menu opened early,
  // or a fresh session) fall back to what we remembered for this identity.
  if (getVoice().hasPeerVolume(peerId)) return getVoice().getPeerVolume(peerId);
  const did = peerIdToDid(peerId);
  if (looksLikeDid(did)) {
    const stored = loadPeerVolume(did);
    if (stored !== null) return stored;
  }
  return getVoice().getPeerVolume(peerId);
}

export function setVoiceDtlnNoiseGate(threshold: number): void {
  saveAudioPrefs({ noiseGate: threshold });
  getDtln().setNoiseGate(threshold);
}

export function getVoiceDtlnNoiseGate(): number {
  return getDtln().getNoiseGate();
}

export async function setVoiceDtlnEnabled(enabled: boolean): Promise<void> {
  saveAudioPrefs({ dtlnEnabled: enabled });
  await getVoice().setDtlnEnabled(enabled);
  // Toggling this restarts the mic, so the old stream's tracks are stopped.
  // Anything still holding the previous stream (the speaking-ring analyser)
  // would read silence from a dead track for the rest of the call.
  transportState.localMicStream = getVoice().getMicStream();
}

export function getVoiceDtlnEnabled(): boolean {
  return getVoice().isDtlnEnabled();
}
