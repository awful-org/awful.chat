/**
 * A hidden sound. Pressing the DMs button seven times in a row plays it and
 * makes every load of the app play it, until seven more. Device-local, like
 * the display preferences.
 *
 * "In a row" is what keeps it hidden: the button is pressed all day, so any
 * press of anything else starts the count again.
 */

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

function onOtherPress(event: Event): void {
  if (!button?.contains(event.target as Node)) presses = 0;
}

/** The DMs button was pressed. */
export function pressDmsButton(el: Element): void {
  if (!button) {
    window.addEventListener("pointerdown", onOtherPress, true);
    window.addEventListener("keydown", onOtherPress, true);
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
  // Imported when needed: the landing page has no use for the sounds.
  import("./sounds").then((sounds) => sounds.playWafuruSound()).catch(() => {});
}
