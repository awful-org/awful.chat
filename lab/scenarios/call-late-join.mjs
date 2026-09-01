/**
 * Someone joins a call that is already running, and sees what is already there.
 *
 * This is the join-replay path, and it is where the worst SFU bug of the week
 * lived: two consumes for one producer made the server answer with the same
 * consumer id and mid, the duplicate media section made the browser reject the
 * whole offer, and from then on NO remote stream could ever be added again -
 * the receive transport was dead for the rest of the call. A late joiner is
 * who exercises it, because every producer already exists when they arrive and
 * all of them arrive at once, in a replay.
 *
 * The other scenarios cannot reach it: there, both peers join an empty call
 * and each producer is announced live, one at a time.
 *
 *   node scenarios/call-late-join.mjs
 *   LAB_APP_URL=https://dev.awful.chat node scenarios/call-late-join.mjs
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { LabPeer } from "../peer.mjs";
import { EXIT_ENVIRONMENT, requireReachableTarget } from "../preflight.mjs";
import { captureOnFailure } from "../capture.mjs";

function appUrl() {
  if (process.env.LAB_APP_URL) return process.env.LAB_APP_URL;
  try {
    return readFileSync(new URL("../.app-url", import.meta.url), "utf8").trim();
  } catch {
    console.error("No app to drive: run ./stack.sh, or set LAB_APP_URL.");
    process.exit(2);
  }
}

const APP = appUrl();
const PORTS = (process.env.LAB_PORTS ?? "9331,9332").split(",").map(Number);
const IMPAIR = process.env.LAB_IMPAIR ?? "clean";
const DEADLINE_MS = Number(process.env.LAB_DEADLINE_MS ?? 60_000);

const impair = (c, p) =>
  execFileSync(new URL("../impair.sh", import.meta.url).pathname, [c, p], {
    encoding: "utf8",
  }).trim();

const fail = [];
const ok = (cond, label, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`);
  if (!cond) fail.push(label);
};

const seesOther = (otherName) => `(() => {
  const txt = document.body.innerText;
  if (/\\bUSERS\\b/.test(txt)) return txt.includes(${JSON.stringify(otherName)}) || null;
  const b = [...document.querySelectorAll('button')]
    .find((x) => (x.getAttribute('aria-label') || '') === 'Toggle user list');
  if (b) b.click();
  return null;
})()`;

impair("lab-browser-1", "clean");
impair("lab-browser-2", IMPAIR === "clean" ? "clean" : IMPAIR);
console.log(`network: host=clean latecomer=${IMPAIR}`);

await requireReachableTarget(PORTS[0], APP);

const alice = new LabPeer(PORTS[0], "Alice", APP);
const bob = new LabPeer(PORTS[1], "Bob", APP);

try {
  await alice.start();
  await bob.start();
  await alice.signUp("Alice");
  await bob.signUp("Bob");

  const room = await alice.createRoom("lab-late");
  console.log(`room: ${room}`);
  await bob.joinRoom(room);

  for (const [peer, other] of [[alice, "Bob"], [bob, "Alice"]]) {
    await peer.waitFor(`${peer.name} sees ${other}`, seesOther(other), { timeout: 90_000 });
  }
  ok(true, "mesh formed");

  // Alice is alone in the call with a camera on, so everything she publishes
  // exists BEFORE Bob arrives. That is the whole point.
  await alice.joinCall();
  await alice.startCamera();
  ok(true, "Alice is in the call with her camera on");

  // Let the producers settle, so Bob's arrival is a replay rather than a race
  // with the live announcement.
  await new Promise((r) => setTimeout(r, 5000));

  await bob.joinCall();
  ok(true, "Bob joined the call late");

  const first = await bob.media();
  let seen = first;
  const deadline = Date.now() + DEADLINE_MS;
  for (;;) {
    seen = await bob.media();
    const gotVideo = seen.videoBytes > first.videoBytes + 5000;
    const gotAudio = seen.audioBytes > first.audioBytes;
    if ((gotVideo && gotAudio) || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  // The camera was published before Bob existed, so this can only have come
  // from the replay.
  ok(
    seen.videoBytes > first.videoBytes + 5000,
    "the late joiner receives the camera that was already live",
    { videoBytes: seen.videoBytes, videoPath: seen.videoPath, videoProto: seen.videoProto }
  );
  ok(seen.audioBytes > first.audioBytes, "the late joiner hears the call", {
    audioBytes: seen.audioBytes,
  });

  const host = await alice.media();
  ok(host.audioBytes > 0, "the host hears the late joiner", { audioBytes: host.audioBytes });

  for (const peer of [alice, bob]) {
    const errs = await peer
      .eval(`JSON.stringify((window.__labErrs || []).slice(0, 5))`)
      .then(JSON.parse);
    ok(errs.length === 0, `${peer.name}: no uncaught errors`, errs);
  }
} catch (err) {
  if (/UNREACHABLE/.test(err.message)) {
    console.log(`ENVIRONMENT ${err.message}`);
    alice.close();
    bob.close();
    impair("lab-browser-2", "clean");
    process.exit(EXIT_ENVIRONMENT);
  }
  ok(false, `aborted: ${err.message}`);
} finally {
  // Before the tabs are closed: the recorder lives in the page.
  await captureOnFailure("late-join", [alice, bob], fail);
  alice.close();
  bob.close();
  impair("lab-browser-2", "clean");
}

console.log(fail.length === 0 ? "\nSCENARIO PASSED" : `\nSCENARIO FAILED: ${fail.join(", ")}`);
process.exit(fail.length === 0 ? 0 : 1);
