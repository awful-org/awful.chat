/**
 * A call loses the network, and comes back on its own.
 *
 * Every other scenario tests SETUP: does a call start on a given network. This
 * one tests REPAIR, which is where every bug fixed this week actually lived - a
 * rejoin ladder that forked into several, a receive transport that could never
 * accept another consume, a voice link torn down and redialed forever. None of
 * those stop a call from starting. They stop it from coming back.
 *
 * Nobody touches the UI after the cut. Recovery has to be the app's own doing.
 *
 *   node scenarios/call-recovery.mjs
 *   LAB_OUTAGE_MS=30000 LAB_APP_URL=https://dev.awful.chat node scenarios/call-recovery.mjs
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
    console.error("No app to drive: run ./stack.sh, or set LAB_APP_URL.");
    process.exit(2);
  }
}

const APP = appUrl();
const PORTS = (process.env.LAB_PORTS ?? "9331,9332").split(",").map(Number);
/** Long enough to kill ICE, short enough that a run is not an afternoon. */
const OUTAGE_MS = Number(process.env.LAB_OUTAGE_MS ?? 20_000);
/** How long the app may take to put the call back together. */
const RECOVER_MS = Number(process.env.LAB_RECOVER_MS ?? 90_000);
/** Connections one tab may hold before this is a leak rather than a repair. */
const PC_CEILING = Number(process.env.LAB_PC_CEILING ?? 40);

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
  if (/\\bUSERS\\b/.test(txt)) return txt.includes(${JSON.stringify("X")}) || null;
  const b = [...document.querySelectorAll('button')]
    .find((x) => (x.getAttribute('aria-label') || '') === 'Toggle user list');
  if (b) b.click();
  return null;
})()`.replace(JSON.stringify("X"), JSON.stringify(otherName));

impair("lab-browser-1", "clean");
impair("lab-browser-2", "clean");

await requireReachableTarget(PORTS[0], APP);

const alice = new LabPeer(PORTS[0], "Alice", APP);
const bob = new LabPeer(PORTS[1], "Bob", APP);

/** Audio arriving at BOTH ends right now, measured over a window. */
async function audioFlowing() {
  const before = { a: await alice.media(), b: await bob.media() };
  await new Promise((r) => setTimeout(r, 4000));
  const after = { a: await alice.media(), b: await bob.media() };
  return {
    growing:
      after.a.audioBytes > before.a.audioBytes && after.b.audioBytes > before.b.audioBytes,
    detail: {
      aliceDelta: after.a.audioBytes - before.a.audioBytes,
      bobDelta: after.b.audioBytes - before.b.audioBytes,
    },
    after,
  };
}

try {
  await alice.start();
  await bob.start();
  await alice.signUp("Alice");
  await bob.signUp("Bob");

  const room = await alice.createRoom("lab-recovery");
  console.log(`room: ${room}`);
  await bob.joinRoom(room);

  for (const [peer, other] of [[alice, "Bob"], [bob, "Alice"]]) {
    await peer.waitFor(`${peer.name} sees ${other}`, seesOther(other), { timeout: 90_000 });
  }

  await alice.joinCall();
  await bob.joinCall();

  const healthy = await audioFlowing();
  ok(healthy.growing, "audio flowing before the outage", healthy.detail);
  const beforeCut = healthy.after;

  console.log(`\n-- cutting Bob's network for ${OUTAGE_MS / 1000}s --`);
  impair("lab-browser-2", "blackout");
  await new Promise((r) => setTimeout(r, OUTAGE_MS));
  impair("lab-browser-2", "clean");
  console.log("-- network restored --\n");

  let recovered = { growing: false, detail: null, after: beforeCut };
  const deadline = Date.now() + RECOVER_MS;
  while (Date.now() < deadline) {
    recovered = await audioFlowing();
    if (recovered.growing) break;
  }
  ok(recovered.growing, "audio came back on its own after the outage", recovered.detail);

  // A rebuild is expected. An unbounded one is the bug: the rejoin ladder that
  // forked ran a full join per rung, and a tab that reaches Chrome's 500
  // connection cap loses voice, the SFU and libp2p on the same line.
  const after = recovered.after;
  ok(
    after.a.pcs < PC_CEILING && after.b.pcs < PC_CEILING,
    "connection count stayed sane through the repair",
    {
      aliceTotal: after.a.pcs, aliceLive: after.a.live,
      bobTotal: after.b.pcs, bobLive: after.b.live,
      builtDuringRepair: after.b.pcs - beforeCut.b.pcs,
    }
  );

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
  alice.close();
  bob.close();
  impair("lab-browser-2", "clean");
}

console.log(fail.length === 0 ? "\nSCENARIO PASSED" : `\nSCENARIO FAILED: ${fail.join(", ")}`);
process.exit(fail.length === 0 ? 0 : 1);
