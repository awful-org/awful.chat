let audioCtx: AudioContext | null = null;
let ringBuffer: AudioBuffer | null = null;
let ringSource: AudioBufferSourceNode | null = null;
let ringGain: GainNode | null = null;

function getCtx(): AudioContext {
  if (!audioCtx) audioCtx = new AudioContext();
  if (audioCtx.state === "suspended") audioCtx.resume();
  return audioCtx;
}

// Autoplay policy: resume() is IGNORED outside a user gesture, so a session
// that never played a gesture-driven sound (joining a call, toggling mute)
// carried a permanently suspended context - incoming-message beeps were
// scheduled into silence. Every gesture re-arms it, not just the first: the
// context can be suspended again later (mobile backgrounding, an audio-session
// interruption), and a one-shot listener left the session mute for good.
if (typeof window !== "undefined") {
  const unlock = () => {
    try {
      getCtx();
    } catch {
      /* no audio here */
    }
  };
  window.addEventListener("pointerdown", unlock, { passive: true });
  window.addEventListener("keydown", unlock, { passive: true });
}

function playOsc(
  freq: number,
  duration: number,
  type: OscillatorType = "sine",
  gain = 0.15,
  attack = 0.005,
  /**
   * Seconds to wait before the note starts, measured on the AUDIO clock.
   * setTimeout is clamped to >=1s in a background tab - exactly where an
   * incoming-message beep matters most - which degraded a two-note chime to a
   * single blip. Anything that has to land inside a few tens of milliseconds
   * belongs here, not in a timer.
   */
  delay = 0
) {
  const ctx = getCtx();
  const osc = ctx.createOscillator();
  const gainNode = ctx.createGain();

  osc.type = type;
  osc.frequency.value = freq;

  const start = ctx.currentTime + delay;
  // A ramp with no preceding event starts from an implementation-defined
  // time. Anchor it so the attack is the same in every browser.
  gainNode.gain.setValueAtTime(0, start);
  gainNode.gain.linearRampToValueAtTime(gain, start + attack);
  gainNode.gain.linearRampToValueAtTime(0, start + duration);

  osc.connect(gainNode);
  gainNode.connect(ctx.destination);

  osc.start(start);
  osc.stop(start + duration);
}

export async function playJoinSound() {
  playOsc(400, 0.08, "sine", 0.12);
  playOsc(600, 0.08, "sine", 0.1);
  setTimeout(() => {
    playOsc(600, 0.12, "sine", 0.1);
    playOsc(900, 0.12, "sine", 0.08);
  }, 60);
}

export async function playLeaveSound() {
  playOsc(600, 0.08, "sine", 0.1);
  playOsc(400, 0.08, "sine", 0.08);
  setTimeout(() => {
    playOsc(400, 0.15, "sine", 0.06);
    playOsc(200, 0.15, "triangle", 0.04);
  }, 60);
}

/**
 * Someone ELSE joined or left the call. Lighter and higher than your own
 * join/leave: you already know when you pressed the button, so those stay the
 * prominent ones, but you still hear the room fill up behind you.
 */
// These two were the quietest cues in the file (0.07 and 0.06) while being the
// only ones that play OVER live call audio - everything else sounds into
// silence. Competing with people talking needs more level, not less, so they
// now sit slightly above the join sound you hear for yourself, and last a
// little longer so a short blip is not lost under a voice.
export async function playPeerJoinSound() {
  playOsc(660, 0.09, "sine", 0.16);
  setTimeout(() => playOsc(880, 0.12, "sine", 0.14), 55);
}

export async function playPeerLeaveSound() {
  // Kept below the join cue: someone arriving is the one you want to look up
  // for. Raised in step with it so the pair still sounds related.
  playOsc(660, 0.09, "sine", 0.13);
  setTimeout(() => playOsc(440, 0.14, "sine", 0.11), 55);
}

export async function playMuteSound() {
  playOsc(400, 0.04, "sine", 0.15);
  playOsc(300, 0.04, "triangle", 0.1);
  setTimeout(() => playOsc(200, 0.06, "sine", 0.08), 30);
}

export async function playUnmuteSound() {
  playOsc(200, 0.04, "sine", 0.08);
  playOsc(300, 0.04, "triangle", 0.1);
  setTimeout(() => playOsc(400, 0.06, "sine", 0.15), 30);
}

export async function playDeafenSound() {
  playOsc(150, 0.1, "sine", 0.2);
  playOsc(100, 0.15, "triangle", 0.15);
  setTimeout(() => playOsc(80, 0.1, "sine", 0.1), 50);
}

export async function playUndeafenSound() {
  playOsc(80, 0.1, "sine", 0.1);
  playOsc(100, 0.15, "triangle", 0.15);
  setTimeout(() => playOsc(150, 0.1, "sine", 0.2), 50);
}

/**
 * An incoming chat message. Softer and shorter than the notification triple:
 * this can fire often, so it has to be ignorable.
 *
 * Both notes are scheduled up front on the audio clock. This is the one cue
 * that plays while the tab is in the background, where a 45 ms setTimeout is
 * clamped to a second and the chime arrives as one lonely blip.
 */
export async function playMessageSound() {
  playOsc(880, 0.05, "sine", 0.06);
  playOsc(1175, 0.07, "sine", 0.05, 0.005, 0.045);
}

export async function playNotifySound() {
  playOsc(800, 0.08, "sine", 0.1);
  setTimeout(() => playOsc(1000, 0.08, "sine", 0.1), 80);
  setTimeout(() => playOsc(800, 0.08, "sine", 0.1), 160);
}

export async function playCameraOnSound() {
  playOsc(1000, 0.05, "sine", 0.08);
  setTimeout(() => playOsc(1200, 0.08, "sine", 0.1), 30);
}

export async function playCameraOffSound() {
  playOsc(1200, 0.05, "sine", 0.08);
  setTimeout(() => playOsc(800, 0.08, "sine", 0.06), 30);
}

export async function playScreenShareStartSound() {
  playOsc(1200, 0.06, "sine", 0.1);
  setTimeout(() => playOsc(1500, 0.06, "sine", 0.1), 50);
  setTimeout(() => playOsc(1800, 0.1, "sine", 0.08), 100);
}

export async function playScreenShareStopSound() {
	playOsc(1800, 0.06, "sine", 0.08);
	setTimeout(() => playOsc(1200, 0.06, "sine", 0.1), 50);
	setTimeout(() => playOsc(900, 0.1, "sine", 0.06), 100);
}

export async function playTransmissionJoinSound() {
	playOsc(600, 0.06, "sine", 0.1);
	setTimeout(() => playOsc(800, 0.08, "sine", 0.1), 40);
}

export async function playTransmissionLeaveSound() {
	playOsc(400, 0.06, "sine", 0.1);
	setTimeout(() => playOsc(300, 0.08, "sine", 0.08), 40);
}

export async function playTransmissionEndedSound() {
	playOsc(500, 0.08, "sine", 0.1);
	setTimeout(() => playOsc(400, 0.08, "sine", 0.08), 60);
	setTimeout(() => playOsc(300, 0.12, "sine", 0.06), 120);
}

// AAC instead of raw PCM: same 9 seconds, ~16x smaller, decodable everywhere.
import callRingUrl from "/sounds/call-ring.m4a?url";

async function loadRingBuffer(): Promise<AudioBuffer> {
  if (ringBuffer) return ringBuffer;
  const res = await fetch(callRingUrl);
  const arrayBuffer = await res.arrayBuffer();
  ringBuffer = await getCtx().decodeAudioData(arrayBuffer);
  return ringBuffer;
}

export async function startRingtone() {
  stopRingtone();
  const buffer = await loadRingBuffer();
  const ctx = getCtx();

  ringGain = ctx.createGain();
  ringGain.gain.value = 0.4;

  ringSource = ctx.createBufferSource();
  ringSource.buffer = buffer;
  ringSource.loop = true;

  ringSource.connect(ringGain);
  ringGain.connect(ctx.destination);
  ringSource.start();
}

export function stopRingtone() {
  if (ringSource) {
    ringSource.stop();
    ringSource.disconnect();
    ringSource = null;
  }
  if (ringGain) {
    ringGain.disconnect();
    ringGain = null;
  }
}

export async function playCallRejectSound() {
  playOsc(300, 0.08, "triangle", 0.15);
  playOsc(200, 0.1, "triangle", 0.1);
  setTimeout(() => playOsc(150, 0.12, "triangle", 0.08), 60);
}
