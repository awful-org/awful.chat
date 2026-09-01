/**
 * Run one scenario across every network, and read the answer off the table.
 *
 * This is the whole point of the lab. A single run tells you a call failed; it
 * cannot tell you why, and neither can any amount of per-event cleverness. The
 * same scenario on a good network and a bad one can:
 *
 *   fails everywhere            -> the code. The network was never the reason.
 *   fails only when impaired    -> the network, and the profile names which
 *                                 impairment it cannot survive.
 *   passes everywhere           -> nothing to chase here today.
 *
 * That comparison is worth more than any single verdict, because it is the
 * question a user actually asks: is it me or is it the app.
 *
 *   node matrix.mjs                       # the default profiles
 *   node matrix.mjs clean loss15          # only these
 */
import { spawn, execFileSync } from "node:child_process";
import { EXIT_ENVIRONMENT } from "./preflight.mjs";

/**
 * Fresh browsers before every profile.
 *
 * `frontend/e2e/run-all.sh` learned this first and wrote it down: "scenarios
 * that pass in isolation failed partway through a long run - which reads as an
 * app bug and is not one". A profile that inherits the previous one's browser
 * state is measuring the run order as much as the app.
 */
function restartBrowsers() {
  try {
    execFileSync(new URL("./up.sh", import.meta.url).pathname, [], {
      stdio: "ignore",
      timeout: 120_000,
    });
    return true;
  } catch {
    return false;
  }
}

const PROFILES = process.argv.slice(2).length
  ? process.argv.slice(2)
  : ["clean", "jitter", "loss3", "loss15", "udp-block"];
const SCENARIO = process.env.LAB_SCENARIO ?? "scenarios/call-audio.mjs";

const run = (profile) =>
  new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [SCENARIO], {
      env: { ...process.env, LAB_IMPAIR: profile },
      cwd: new URL(".", import.meta.url).pathname,
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      const failed = [...out.matchAll(/^FAIL (.+?)(?: \{|$)/gm)].map((m) => m[1]);
      const environment = code === EXIT_ENVIRONMENT;
      // Scraped from the scenario's own summary line. This used to look for
      // "relayed: alice=true", which the scenario has never printed, so the
      // column read false in every run - including the ones that were
      // genuinely relayed through TURN. A diagnostic that quietly reports the
      // wrong answer is worse than one that reports nothing.
      const relayed = /relayed: (true|false)\/(true|false)/.exec(out);
      const anyRelayed = relayed ? relayed[1] === "true" || relayed[2] === "true" : false;
      resolve({
        profile,
        ok: code === 0,
        environment,
        failed,
        relayed: anyRelayed,
        seconds: Math.round((Date.now() - started) / 1000),
        out,
      });
    });
  });

const results = [];
for (const profile of PROFILES) {
  process.stdout.write(`running ${profile}... `);
  restartBrowsers();
  let r = await run(profile);
  // One retry before calling it a failure. A single run is a sample, not a
  // measurement, and a flake reported as a finding costs someone an afternoon
  // reading code that was never wrong.
  if (!r.ok && !r.environment) {
    process.stdout.write("retry... ");
    restartBrowsers();
    const again = await run(profile);
    if (again.ok) again.flaky = true;
    r = again.ok ? again : r;
  }
  console.log(
    `${r.environment ? "ENVIRONMENT" : r.ok ? (r.flaky ? "pass (flaky)" : "pass") : "FAIL"} (${r.seconds}s)`
  );
  results.push(r);
}

console.log("\n profile      result  relayed  failed");
console.log(" ------------------------------------------------------");
for (const r of results) {
  const state = r.environment ? "env" : r.ok ? (r.flaky ? "flaky" : "pass") : "FAIL";
  console.log(
    ` ${r.profile.padEnd(12)} ${state.padEnd(7)} ${String(r.relayed).padEnd(8)} ${r.failed.join(", ")}`
  );
}

// The reading, spelled out, so nobody has to remember the rule.
const env = results.filter((r) => r.environment);
const tested = results.filter((r) => !r.environment);
const failures = tested.filter((r) => !r.ok);
const clean = tested.find((r) => r.profile === "clean");
console.log("");
if (env.length > 0) {
  console.log(
    `INCONCLUSIVE for ${env.map((r) => r.profile).join(", ")}: never reached an` +
      " assertion because the target or the lab was unavailable. Not a claim" +
      " about the app."
  );
}
if (tested.length === 0) {
  // Saying "healthy" here is how a harness earns distrust: nothing ran.
  console.log("VERDICT: none. Nothing was actually tested.");
} else if (failures.length === 0) {
  console.log(
    `VERDICT: healthy on ${tested.map((r) => r.profile).join(", ")}.` +
      (env.length > 0 ? " The rest were not tested." : "")
  );
} else if (clean && !clean.ok) {
  console.log(
    "VERDICT: CODE. It fails on a clean network, so no network condition is the cause."
  );
} else if (!clean) {
  console.log(
    `VERDICT: fails on ${failures.map((f) => f.profile).join(", ")}, but "clean"` +
      " was not among the profiles tested, so this cannot yet be separated from" +
      " a fault that fails everywhere. Re-run including clean."
  );
} else {
  console.log(
    `VERDICT: NETWORK-DEPENDENT. Only these profiles fail: ${failures
      .map((f) => f.profile)
      .join(", ")}. The app survives a clean network, so this is what it cannot survive.`
  );
}
process.exit(failures.length === 0 && env.length === 0 ? 0 : 1);
