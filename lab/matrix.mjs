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
import { spawn } from "node:child_process";

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
  const r = await run(profile);
  console.log(`${r.ok ? "pass" : "FAIL"} (${r.seconds}s)`);
  results.push(r);
}

console.log("\n profile      result  relayed  failed");
console.log(" ------------------------------------------------------");
for (const r of results) {
  console.log(
    ` ${r.profile.padEnd(12)} ${(r.ok ? "pass" : "FAIL").padEnd(7)} ${String(r.relayed).padEnd(8)} ${r.failed.join(", ")}`
  );
}

// The reading, spelled out, so nobody has to remember the rule.
const failures = results.filter((r) => !r.ok);
const clean = results.find((r) => r.profile === "clean");
console.log("");
if (failures.length === 0) {
  console.log("VERDICT: healthy on every network tested.");
} else if (clean && !clean.ok) {
  console.log(
    "VERDICT: CODE. It fails on a clean network, so no network condition is the cause."
  );
} else {
  console.log(
    `VERDICT: NETWORK-DEPENDENT. Only these profiles fail: ${failures
      .map((f) => f.profile)
      .join(", ")}. The app survives a clean network, so this is what it cannot survive.`
  );
}
process.exit(failures.length === 0 ? 0 : 1);
