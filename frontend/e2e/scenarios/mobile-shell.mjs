/**
 * The app shell on a phone-shaped window.
 *
 * Every mobile layout bug this repo has shipped had the same shape: something
 * off the bottom of the screen, or something wider than the screen, on a
 * viewport nobody ran the tests at. So this one runs the ordinary first-run
 * path - sign up, make a room - at 390x844 and checks the geometry.
 *
 * Honest about its limits, because the alternative is a test that claims more
 * than it proves:
 *
 *   - It cannot emulate touch. Firefox's BiDi has no device emulation, so
 *     `(pointer: coarse)` is false here and the touch-only branches (the
 *     call controls' coarse-pointer sizing, tap-to-act on a message) are NOT
 *     covered. Only the width-driven mobile branches are.
 *   - It cannot emulate a safe-area inset. `env(safe-area-inset-*)` is
 *     UA-controlled and no stylesheet or CSS variable can set it, so what is
 *     checked is that the header's `calc(3.25rem + env(...))` PARSED - with no
 *     inset the answer is exactly 52px, and a typo in that expression gives an
 *     auto height instead. That catches the mistake that would actually be
 *     made; it does not prove the notch is cleared on real hardware.
 *   - It cannot open a software keyboard. Shrinking the window is the closest
 *     thing available, and it shrinks the LAYOUT viewport where a keyboard
 *     only shrinks the visual one - so it is labelled "short window", not
 *     "keyboard", and it proves the composer survives a short window.
 */
import { Peer, closeAll } from "../driver.mjs";
import { Check } from "../assert.mjs";

const check = new Check("the app shell on a phone-shaped window");
const alice = new Peer(9307, "Alice");

/** Everything that renders wider than the window it is in. */
const OVERFLOW_PROBE = `(() => {
  const w = document.documentElement.clientWidth;
  const wide = [...document.querySelectorAll('body *')]
    .filter((el) => {
      const r = el.getBoundingClientRect();
      // 1px of slack for subpixel layout; ignore anything not painted.
      return r.width > 0 && r.height > 0 && (r.right > w + 1 || r.left < -1);
    })
    .slice(0, 5)
    .map((el) => el.tagName.toLowerCase() + '.' + (el.className.baseVal ?? el.className ?? '').toString().slice(0, 40));
  return JSON.stringify({ w, scrollWidth: document.documentElement.scrollWidth, wide });
})()`;

/** Is the composer's text field on screen, and inside the window? */
const COMPOSER_PROBE = `(() => {
  const el = document.querySelector('textarea');
  if (!el) return JSON.stringify({ found: false });
  const r = el.getBoundingClientRect();
  return JSON.stringify({
    found: true,
    onScreen: r.height > 0 && r.top >= 0 && r.bottom <= window.innerHeight + 1,
    insideWidth: r.left >= -1 && r.right <= document.documentElement.clientWidth + 1,
    top: Math.round(r.top),
    bottom: Math.round(r.bottom),
    innerHeight: window.innerHeight,
  });
})()`;

const HEADER_PROBE = `(() => {
  const el = document.querySelector('header');
  if (!el) return JSON.stringify({ found: false });
  const s = getComputedStyle(el);
  return JSON.stringify({
    found: true,
    height: s.height,
    paddingTop: s.paddingTop,
  });
})()`;

try {
  await alice.start({ mobile: true });

  const viewport = await alice.json(
    `JSON.stringify({ w: window.innerWidth, h: window.innerHeight })`
  );
  check.equal(viewport.w, 390, "the window is phone width");

  await alice.signUp("Alice");
  check.ok(
    await alice.eval(`window.matchMedia('(max-width: 639px)').matches`),
    "the app's own mobile breakpoint is active"
  );

  // The first-run screens are the ones that centre a card with a text field
  // in it, so check them before leaving for a room.
  let overflow = await alice.json(OVERFLOW_PROBE);
  check.ok(
    overflow.scrollWidth <= overflow.w + 1,
    "nothing overflows the room picker horizontally",
    overflow
  );

  await alice.createRoom("Mobile");

  const header = await alice.json(HEADER_PROBE);
  check.ok(header.found, "the chat header rendered");
  // 3.25rem + a zero inset. An unparseable calc() would leave this `auto`,
  // which is the mistake this can actually catch. See the note at the top.
  check.equal(header.height, "52px", "the header's safe-area calc parsed");
  check.ok(
    /^\d+(\.\d+)?px$/.test(header.paddingTop ?? ""),
    "the header's safe-area padding resolves to a length",
    header
  );

  overflow = await alice.json(OVERFLOW_PROBE);
  check.ok(
    overflow.scrollWidth <= overflow.w + 1 && overflow.wide.length === 0,
    "nothing in the room overflows horizontally",
    overflow
  );

  let composer = await alice.json(COMPOSER_PROBE);
  check.ok(composer.found, "the composer rendered");
  check.ok(composer.onScreen, "the composer is on screen", composer);
  check.ok(composer.insideWidth, "the composer fits the width", composer);

  // A short window. Not a keyboard - see the note at the top - but it is the
  // case where a stage sized in `vh` used to push the composer off the bottom.
  await alice.setViewport({ width: 390, height: 420 });
  await alice.waitFor("short window applied", async () =>
    (await alice.eval(`window.innerHeight`)) <= 460
  );
  composer = await alice.json(COMPOSER_PROBE);
  check.ok(
    composer.found && composer.onScreen,
    "the composer survives a short window",
    composer
  );
  overflow = await alice.json(OVERFLOW_PROBE);
  check.ok(
    overflow.scrollWidth <= overflow.w + 1,
    "nothing overflows horizontally in a short window",
    overflow
  );
} finally {
  await closeAll([alice]);
}

check.finish();
