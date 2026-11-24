/**
 * A hidden sound. Pressing the DMs button seven times in a row plays it and
 * makes every load of the app play it, until seven more. Device-local, like
 * the display preferences.
 *
 * "In a row" is what keeps it hidden, as the button is pressed all day: a
 * second without a press, or a press of anything else, starts the count again.
 */

import { playWafuruOffSound, playWafuruSound } from "./sounds";

const KEY = "awful:boot-sound:v1";

const PRESSES = 7;
const PAUSE_MS = 1000;

export function bootSoundOn(): boolean {
  try {
    return localStorage.getItem(KEY) === "1";
  } catch {
    return false;
  }
}

function setBootSound(on: boolean): void {
  try {
    if (on) localStorage.setItem(KEY, "1");
    else localStorage.removeItem(KEY);
  } catch {
    /* no storage: nothing to remember it with */
  }
}

let presses = 0;
let lastPress = 0;
let button: Element | null = null;

function onOther(event: Event): void {
  // A held Enter presses the button over and over: that is one press.
  const held = "repeat" in event && event.repeat;
  if (held || !button?.contains(event.target as Node)) presses = 0;
}

/** The DMs button was pressed. */
export function pressDmsButton(el: Element): void {
  if (!button) {
    window.addEventListener("pointerdown", onOther, true);
    window.addEventListener("keydown", onOther, true);
  }
  button = el;
  const now = performance.now();
  if (now - lastPress >= PAUSE_MS) presses = 0;
  lastPress = now;
  if (++presses < PRESSES) return;
  presses = 0;
  const on = !bootSoundOn();
  setBootSound(on);
  if (on) play();
  else playWafuruOffSound().catch(() => {});
}

/** The app was loaded. */
export function playBootSound(): void {
  if (bootSoundOn()) play();
}

function play(): void {
  playWafuruSound().catch(() => {});
}
