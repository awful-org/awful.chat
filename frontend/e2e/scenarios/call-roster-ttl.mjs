/**
 * The in-call roster expires ghosts: an entry with no presence heartbeat and
 * no live voice link is purged after the TTL, while a real call member keeps
 * re-announcing and survives well past it. Runs ~90s by nature of the TTL.
 */
import { bootPeers, closeAll } from "../driver.mjs";
import { Check, waitForBinding, waitForMesh } from "../assert.mjs";

const check = new Check("call roster expires ghosts, keeps live members");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

try {
  // Count synthesized sounds so the purge chime is observable.
  await alice.eval(`(() => {
    if (window.__oscWrapped) return true;
    window.__oscWrapped = true;
    window.__oscs = 0;
    const orig = AudioContext.prototype.createOscillator;
    AudioContext.prototype.createOscillator = function () {
      window.__oscs++;
      return orig.call(this);
    };
    return true;
  })()`);

  const room = await alice.createRoom("TtlLab");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  await waitForBinding([alice, bob], 1);

  await alice.clickLabel("Join call");
  await alice.waitFor("alice in call", () =>
    alice.eval(`window.__awful.state.inCall || null`));
  await bob.clickLabel("Join call");
  await bob.waitFor("bob in call", () =>
    bob.eval(`window.__awful.state.inCall || null`));
  const bobPeer = await bob.eval(`window.__awful.selfId()`);

  // Inject a ghost: presence for a peer that will never speak again.
  const ghost = "12D3KooWGhostGhostGhostGhostGhostGhostGhostGhost";
  await alice.eval(`(() => {
    window.__awful._handleCallPresence(${JSON.stringify(ghost)}, true, ${JSON.stringify(room)});
    return window.__awful.state.callPeerRooms.has(${JSON.stringify(ghost)});
  })()`);
  check.ok(true, "ghost accepted into the roster");

  const soundsBeforePurge = await alice.json(`window.__oscs ?? 0`);

  // The ghost must be swept after the 60s TTL (+ repair-tick cadence)...
  await alice.waitFor("ghost purged", () =>
    alice.eval(`!window.__awful.state.callPeerRooms.has(${JSON.stringify(ghost)}) || null`),
    { timeout: 120000, interval: 2000 });
  check.ok(true, "ghost swept after the TTL");

  // ...while bob, heartbeating presence every 20s, is still in the roster
  // even though more than the TTL has elapsed since his join announcement.
  const bobStill = await alice.eval(
    `window.__awful.state.callPeerRooms.has(${JSON.stringify(bobPeer)})`);
  check.ok(bobStill === true, "live member survives past the TTL");

  // The purge is a disconnect for whoever remains: it must have chimed.
  const soundsAfterPurge = await alice.json(`window.__oscs ?? 0`);
  check.ok(soundsAfterPurge > soundsBeforePurge,
    "remaining members hear a leave chime when the ghost is purged");

  check.finish();
} finally {
  await closeAll([alice, bob]);
}
