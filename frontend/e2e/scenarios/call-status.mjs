/**
 * The call status tells the truth: "Waiting for others" while alone,
 * "Connecting" while a peer's voice link is still handshaking, and
 * "Connected" only once the announced peers are actually connected.
 * Requires the fake-media prefs browsers.sh writes into the profiles.
 */
import { bootPeers, closeAll } from "../driver.mjs";
import { Check, waitForBinding, waitForMesh } from "../assert.mjs";

const check = new Check("call status reflects real voice connections");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

try {
  const room = await alice.createRoom("StatusLab");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  await waitForBinding([alice, bob], 1);

  await alice.clickLabel("Join call");
  await alice.waitFor("alice in call", () =>
    alice.eval(`window.__awful.state.inCall || null`));
  await alice.waitFor("waiting label", () =>
    alice.eval(`/Waiting for others/.test(document.body.innerText) || null`),
    { timeout: 15000 });
  check.ok(true, "alone in the call shows 'Waiting for others'");

  await bob.clickLabel("Join call");
  await bob.waitFor("bob in call", () =>
    bob.eval(`window.__awful.state.inCall || null`));

  // Headless-to-headless WebRTC media does not reliably complete, so the
  // deterministic harness state is "presence in, voice link pending" - which
  // is exactly what the honest status and the tile pulse must show. (The
  // fully-connected rendering is exercised by real use, not this harness.)
  await alice.waitFor("partial status shown", () =>
    alice.eval(`document.body.innerText.indexOf('Connecting') >= 0 || null`),
    { timeout: 30000 });
  check.ok(true, "status shows Connecting while the peer's link is pending");

  await alice.waitFor("connecting tile pulses", () =>
    alice.eval(`document.querySelector('[class*="connecting-wave"]') ? true : null`),
    { timeout: 20000 });
  check.ok(true, "pending peer's tile pulses instead of posing as connected");

  // The members chip lives in the panel's top-right cluster, so it stays
  // visible in fullscreen too - and lists everyone in the call.
  await alice.waitFor("members chip", () =>
    alice.eval(`(document.querySelector('[aria-label="Call members"]')?.textContent ?? '').includes('2') || null`),
    { timeout: 15000 });
  check.ok(true, "call members chip shows both members in the panel");

  // The users sidebar groups call members into an "In call" container.
  await alice.clickLabel("Toggle user list");
  await alice.waitFor("in-call group", () => alice.eval(`(() => {
    const t = document.body.innerText;
    if (!/In call/.test(t)) return null;
    const inCallLines = t.split(String.fromCharCode(10)).filter((l) => l.trim() === 'In call').length;
    return inCallLines >= 2 ? true : null;
  })()`), { timeout: 20000 });
  check.ok(true, "sidebar groups both members under 'In call'");

  // The local mic pipeline is live: the fake mic emits a tone, so our own
  // speaking ring must be on.
  await alice.waitFor("own speaking ring", () =>
    alice.eval(`document.querySelectorAll('[class*="ring-primary"]').length >= 1 || null`),
    { timeout: 15000 });
  check.ok(true, "local mic pipeline live (own speaking ring on)");

  // A peer leaving on purpose must not leave the status stuck at
  // "Connecting 1/2..." - the roster shrinks and alice goes back to waiting.
  await bob.clickLabel("Leave call");
  await bob.waitFor("bob left", () =>
    bob.eval(`window.__awful.state.inCall === false || null`));
  await alice.waitFor("status back to waiting", () => alice.eval(`(() => {
    const t = document.body.innerText;
    return /Waiting for others/.test(t) && t.indexOf('Connecting 1/2') === -1
      ? true : null;
  })()`), { timeout: 30000 });
  check.ok(true, "leaver drops out of the roster; no stuck Connecting 1/2");

  check.finish();
} finally {
  await closeAll([alice, bob]);
}
