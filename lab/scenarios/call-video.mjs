/**
 * One peer turns a camera on, and the other actually receives the video.
 *
 * The first test in this repo that asserts the SFU forwards anything. Voice is
 * peer to peer and never touches it, so `call-audio.mjs` passing says nothing
 * about camera or screen share - and the SFU is half of what breaks in
 * production.
 *
 * It is also the only test of the SFU's TCP candidates. mediasoup announces
 * both UDP and TCP in its RTC port range; the TCP half exists exactly for the
 * users who cannot send UDP, and it is invisible until one of them shows up.
 * Under LAB_IMPAIR=udp-block the receiving peer has no UDP at all, so a pass
 * means the TCP path is open and working end to end.
 *
 *   node scenarios/call-video.mjs
 *   LAB_IMPAIR=udp-block LAB_APP_URL=https://dev.awful.chat node scenarios/call-video.mjs
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { LabPeer } from "../peer.mjs";
import { EXIT_ENVIRONMENT, requireReachableTarget } from "../preflight.mjs";

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
const VIDEO_DEADLINE_MS = Number(process.env.LAB_VIDEO_DEADLINE_MS ?? 60_000);

const impair = (container, profile) =>
  execFileSync(new URL("../impair.sh", import.meta.url).pathname, [container, profile], {
    encoding: "utf8",
  }).trim();

const fail = [];
const ok = (cond, label, extra) => {
  console.log(`${cond ? "PASS" : "FAIL"} ${label}${extra === undefined ? "" : ` ${JSON.stringify(extra)}`}`);
  if (!cond) fail.push(label);
};

// The WATCHER is the impaired one: receiving is the harder direction, and it
// is the direction a viewer complains about.
impair("lab-browser-1", "clean");
impair("lab-browser-2", IMPAIR === "clean" ? "clean" : IMPAIR);
console.log(`network: sharer=clean watcher=${IMPAIR}`);

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

  const room = await alice.createRoom("lab-video");
  console.log(`room: ${room}`);
  await bob.joinRoom(room);

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

  await alice.startCamera();
  ok(true, "Alice's camera is on");

  // Video has to ARRIVE at Bob, and keep arriving. Everything up to here can
  // be true while the SFU forwards nothing: the transport connects, the
  // producer is announced, the tile appears, and no frame ever lands.
  const first = await bob.media();
  let seen = first;
  const deadline = Date.now() + VIDEO_DEADLINE_MS;
  for (;;) {
    seen = await bob.media();
    if (seen.videoBytes > first.videoBytes + 5000 || Date.now() > deadline) break;
    await new Promise((r) => setTimeout(r, 2000));
  }

  ok(seen.videoBytes > first.videoBytes + 5000, "Bob receives Alice's camera", {
    videoBytes: seen.videoBytes,
    videoPath: seen.videoPath,
    videoProto: seen.videoProto,
    videoRelayed: seen.videoRelayed,
  });

  // With no UDP at all, media that arrives can only have come over ICE-TCP.
  // Asserting the protocol rather than inferring it from "it worked": the
  // candidate TYPE does not name the transport, and a pass that assumed one
  // would be a claim this lab had not measured.
  if (IMPAIR === "udp-block") {
    ok(seen.videoProto === "tcp", "the SFU leg used TCP, as it must here", {
      videoProto: seen.videoProto,
    });
  }

  // Which path the SFU leg took. Under udp-block a pass here means the SFU's
  // TCP candidate range is reachable, which nothing else in this repo checks.
  console.log(
    `sfu path: ${seen.videoPath} over ${seen.videoProto}  relayed: ${seen.videoRelayed}  ` +
      `video bytes: ${first.videoBytes} -> ${seen.videoBytes}  pcs: ${seen.live}/${seen.pcs}`
  );

  // Voice should still be up alongside it; a camera must not cost the call.
  ok(seen.audioBytes > 0, "voice still flowing alongside video", {
    audioBytes: seen.audioBytes,
  });

  for (const peer of [alice, bob]) {
    const errs = await peer
      .eval(`JSON.stringify((window.__labErrs || []).slice(0, 5))`)
      .then(JSON.parse);
    ok(errs.length === 0, `${peer.name}: no uncaught errors`, errs);
  }
} catch (err) {
  // An unreachable target mid-run is the environment, not the app.
  if (/UNREACHABLE/.test(err.message)) {
    console.log(`ENVIRONMENT ${err.message}`);
    alice.close();
    bob.close();
    impair("lab-browser-2", "clean");
    process.exit(EXIT_ENVIRONMENT);
  }
  ok(false, `aborted: ${err.message}`);
} finally {
  alice.close();
  bob.close();
  impair("lab-browser-2", "clean");
}

console.log(fail.length === 0 ? "\nSCENARIO PASSED" : `\nSCENARIO FAILED: ${fail.join(", ")}`);
process.exit(fail.length === 0 ? 0 : 1);
