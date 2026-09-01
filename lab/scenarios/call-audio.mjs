/**
 * Two people join a call and can actually hear each other.
 *
 * This is the assertion the repo has never had. Every existing call test
 * asserts a counter - an offer was sent, a roster holds two names - because
 * headless Firefox never completes ICE there. A counter cannot tell a working
 * call from a deaf pair, and a deaf pair is precisely what users report.
 *
 *   node scenarios/call-audio.mjs            # both peers on a clean network
 *   LAB_IMPAIR=loss3 node scenarios/call-audio.mjs   # peer 2 on a bad one
 *
 * Run it twice, clean and impaired, and compare: a failure in both is the
 * code, a failure only when impaired is the network.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { LabPeer } from "../peer.mjs";
import { EXIT_ENVIRONMENT, requireReachableTarget } from "../preflight.mjs";

// Mode A points at the lab's own stack (./stack.sh writes .app-url); Mode B
// points at a deployed instance:
//   LAB_APP_URL=https://dev.awful.chat node scenarios/call-audio.mjs
function appUrl() {
  if (process.env.LAB_APP_URL) return process.env.LAB_APP_URL;
  try {
    return readFileSync(new URL("../.app-url", import.meta.url), "utf8").trim();
  } catch {
    console.error(
      "No app to drive. Either run ./stack.sh for the lab's own stack, or set\n" +
        "LAB_APP_URL=https://your-instance to drive a deployed one."
    );
    process.exit(2);
  }
}
const APP = appUrl();
const PORTS = (process.env.LAB_PORTS ?? "9331,9332").split(",").map(Number);
const IMPAIR = process.env.LAB_IMPAIR ?? "clean";
/** Audio must arrive within this long after both are in the call. */
const AUDIO_DEADLINE_MS = Number(process.env.LAB_AUDIO_DEADLINE_MS ?? 45_000);

const impair = (container, profile) =>
  execFileSync(new URL("../impair.sh", import.meta.url).pathname, [container, profile], {
    encoding: "utf8",
  }).trim();

const fail = [];
const ok = (cond, label, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`);
  if (!cond) fail.push(label);
};

// Always start from a known network, whatever the last run left behind.
impair("lab-browser-1", "clean");
impair("lab-browser-2", IMPAIR === "clean" ? "clean" : IMPAIR);
console.log(`network: peer1=clean peer2=${IMPAIR}`);

// Before anything is impaired or asserted: if the target is not serving the
// app, this run has no claim to make about it.
await requireReachableTarget(PORTS[0], APP);

const alice = new LabPeer(PORTS[0], "Alice", APP);
const bob = new LabPeer(PORTS[1], "Bob", APP);

try {
  await alice.start();
  await bob.start();
  await alice.signUp("Alice");
  await bob.signUp("Bob");

  const room = await alice.createRoom("lab");
  console.log(`room: ${room}`);
  await bob.joinRoom(room);

  // The other person, in the app's own user list. That list is COLLAPSED by
  // default, which is why a name never appears in the page text until it is
  // opened - three earlier versions of this check called a healthy mesh a
  // failure for that reason alone.
  //
  // Deliberately not a live RTCPeerConnection: with UDP blocked libp2p reaches
  // the peer over the circuit relay and builds none. Deliberately not
  // prod-smoke.mjs's "1 peer", which this UI has stopped saying.
  for (const [peer, otherName] of [[alice, "Bob"], [bob, "Alice"]]) {
    await peer.waitFor(
      `${peer.name} sees ${otherName} in the user list`,
      `(() => {
        const txt = document.body.innerText;
        if (/\\bUSERS\\b/.test(txt)) return txt.includes(${JSON.stringify(otherName)}) || null;
        const b = [...document.querySelectorAll('button')]
          .find((x) => (x.getAttribute('aria-label') || '') === 'Toggle user list');
        if (b) b.click();
        return null;
      })()`,
      { timeout: 90_000 }
    );
  }
  ok(true, "mesh formed");

  await alice.joinCall();
  await bob.joinCall();
  ok(true, "both in the call");

  // Now the only thing that matters: audio that ARRIVED, and is still
  // arriving. A byte count that is merely non-zero can be a stream that died
  // ten seconds ago, so require it to GROW across a sample.
  const first = { alice: await alice.media(), bob: await bob.media() };
  await new Promise((r) => setTimeout(r, 5000));
  let heard = { alice: null, bob: null };
  const deadline = Date.now() + AUDIO_DEADLINE_MS;
  for (;;) {
    heard = { alice: await alice.media(), bob: await bob.media() };
    const growing =
      heard.alice.audioBytes > first.alice.audioBytes &&
      heard.bob.audioBytes > first.bob.audioBytes;
    if (growing || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  ok(heard.alice.audioBytes > first.alice.audioBytes, "Alice hears Bob", heard.alice);
  ok(heard.bob.audioBytes > first.bob.audioBytes, "Bob hears Alice", heard.bob);

  // Relayed or not is what makes a verdict attributable: a call that only
  // works through TURN is a different report from one that never connects.
  console.log(
    `path: alice=${heard.alice.path} bob=${heard.bob.path}` +
      `  relayed: ${heard.alice.relayed}/${heard.bob.relayed}` +
      `  rtt: ${heard.alice.rtt}ms/${heard.bob.rtt}ms` +
      `  pcs: ${heard.alice.live}/${heard.alice.pcs} and ${heard.bob.live}/${heard.bob.pcs}`
  );

  // An uncaught throw in either tab is a fact worth failing on, whatever else
  // happened: nothing in the app is supposed to reach the window.
  for (const peer of [alice, bob]) {
    const errs = await peer.eval(`JSON.stringify((window.__labErrs || []).slice(0, 5))`).then(JSON.parse);
    ok(errs.length === 0, `${peer.name}: no uncaught errors`, errs);
  }
} catch (err) {
  // An unreachable target mid-run is the environment, not the app - the same
  // distinction preflight makes, applied to a blip that lands after it.
  if (/UNREACHABLE/.test(err.message)) {
    console.log(`ENVIRONMENT ${err.message}`);
    alice.close();
    bob.close();
    impair("lab-browser-2", "clean");
    process.exit(EXIT_ENVIRONMENT);
  }
  // Without this the matrix shows a bare FAIL with no reason, and its verdict
  // speaks as though the assertions had run and disagreed.
  ok(false, `aborted: ${err.message}`);
} finally {
  alice.close();
  bob.close();
  impair("lab-browser-2", "clean");
}

console.log(fail.length === 0 ? "\nSCENARIO PASSED" : `\nSCENARIO FAILED: ${fail.join(", ")}`);
process.exit(fail.length === 0 ? 0 : 1);
