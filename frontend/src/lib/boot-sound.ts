/**
 * A hidden sound. Pressing the DMs button seven times in a row plays it and
 * makes every load of the app play it, until seven more. Device-local, like
 * the display preferences.
 *
 * "In a row" is what keeps it hidden: the button is pressed all day, so
 * pressing, typing or scrolling anything else, or leaving the window, starts
 * the count again.
 */

import { playWafuruSound } from "./sounds";

const KEY = "awful:boot-sound:v1";

const PRESSES = 7;

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
let button: Element | null = null;

function onOther(event: Event): void {
  // A held Enter presses the button over and over: that is one press.
  const held = "repeat" in event && event.repeat;
  if (held || !button?.contains(event.target as Node)) presses = 0;
}

/** The DMs button was pressed. */
export function pressDmsButton(el: Element): void {
  if (!button) {
    // A click inside another site's frame reaches this page only as a blur.
    for (const type of ["pointerdown", "keydown", "wheel", "blur"]) {
      window.addEventListener(type, onOther, { capture: true, passive: true });
    }
  }
  button = el;
  if (++presses < PRESSES) return;
  presses = 0;
  const on = !bootSoundOn();
  setBootSound(on);
  if (on) play();
}

/** The app was loaded. */
export function playBootSound(): void {
  if (bootSoundOn()) play();
}

function play(): void {
  playWafuruSound().catch(() => {});
}
