/**
 * Run everything, repeatedly, and write down exactly what happened.
 *
 * The single-run scenarios answer "does this work right now". This answers the
 * question that actually matters for fixing things: WHICH combinations fail,
 * HOW OFTEN, and what the app itself recorded while failing. Intermittent
 * faults are the whole problem here - the late-join replay fails perhaps half
 * the time - and a harness that runs each case once cannot tell an intermittent
 * bug from a flaky test.
 *
 * Every run captures the app's own flight recorder, passes included, because a
 * failing bundle means little without a healthy one beside it.
 *
 *   node super.mjs                                  # the default plan
 *   LAB_APP_URL=https://dev.awful.chat node super.mjs
 *   LAB_REPEATS=3 node super.mjs
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { EXIT_ENVIRONMENT } from "./preflight.mjs";

const HERE = new URL(".", import.meta.url).pathname;
const REPEATS = Number(process.env.LAB_REPEATS ?? 2);
const APP = process.env.LAB_APP_URL ?? "(lab stack)";

/**
 * What to run. Profiles are chosen per scenario rather than as a full cross
 * product: running late-join on six networks costs an hour and tells you less
 * than running it three times on one, because its failure is not
 * network-dependent.
 */
const PLAN = [
  { scenario: "call-audio", profiles: ["clean", "jitter", "loss15", "udp-block"] },
  { scenario: "call-video", profiles: ["clean", "udp-block"] },
  { scenario: "call-late-join", profiles: ["clean"], repeats: 4 },
  { scenario: "call-recovery", profiles: ["clean"] },
];

function restartBrowsers() {
  try {
    execFileSync(`${HERE}up.sh`, [], { stdio: "ignore", timeout: 120_000 });
    return true;
  } catch {
    return false;
  }
}

function runOnce(scenario, profile) {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn(process.execPath, [`scenarios/${scenario}.mjs`], {
      cwd: HERE,
      env: { ...process.env, LAB_IMPAIR: profile, LAB_CAPTURE_ALWAYS: "1" },
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) => {
      resolve({
        scenario,
        profile,
        code,
        environment: code === EXIT_ENVIRONMENT,
        ok: code === 0,
        seconds: Math.round((Date.now() - started) / 1000),
        failures: [...out.matchAll(/^FAIL (.+?)(?: \{|$)/gm)].map((m) => m[1]),
        detail: [...out.matchAll(/^(?:PASS|FAIL) .+$/gm)].map((m) => m[0]),
        captures: [...out.matchAll(/^ {2}(\/.+\.json)$/gm)].map((m) => m[1]),
        tail: out.trim().split("\n").slice(-25).join("\n"),
      });
    });
  });
}

/** The handful of facts from a bundle that explain a call failure. */
function readBundle(file) {
  try {
    const b = JSON.parse(readFileSync(file, "utf8"));
    const events = b.events ?? [];
    const kind = (k) => events.filter((e) => e.kind === k);
    const consume = events.filter((e) => e.kind.startsWith("sfu.consume"));
    const phases = {};
    for (const e of consume) {
      const p = e.kind === "sfu.consume.failed" ? "failed" : (e.d?.phase ?? "?");
      phases[p] = (phases[p] ?? 0) + 1;
    }
    const media = kind("voice.media.sample");
    return {
      file: file.split("/").pop(),
      self: (b.self?.peerId ?? "?").slice(-8),
      events: events.length,
      roomPeerCount: kind("sfu.caps").map((e) => e.d?.roomPeerCount ?? null),
      consumePhases: phases,
      consumeFailures: events
        .filter((e) => e.kind === "sfu.consume.failed")
        .map((e) => String(e.d?.err ?? "").slice(0, 120)),
      produced: kind("sfu.produce").map((e) => `${e.d?.source}/${e.d?.kind}`),
      transports: kind("sfu.transport.state").map((e) => `${e.d?.direction}:${e.d?.state}`),
      sfuErrors: kind("sfu.error").map((e) => String(e.d?.message ?? "").slice(0, 120)),
      rejoins: kind("sfu.rejoin").length,
      wsCloses: kind("sfu.ws.close").length,
      uncaught: kind("runtime.error").map((e) => String(e.d?.err ?? "").slice(0, 120)),
      turn: [...kind("ice.turn.ok"), ...kind("ice.turn.fail")].map(
        (e) => `${e.kind}:${e.d?.branch ?? "creds"}`
      ),
      lastMediaSample: media.length ? media[media.length - 1].d : null,
      relayedVoice: media.some((e) => String(e.d?.path ?? "").includes("relay")),
    };
  } catch (err) {
    return { file, error: err.message.slice(0, 120) };
  }
}

// ---------------------------------------------------------------------------

const started = new Date();
const results = [];
let plannedTotal = 0;
for (const step of PLAN) plannedTotal += step.profiles.length * (step.repeats ?? REPEATS);

console.log(`super test: ${plannedTotal} runs against ${APP}\n`);
let n = 0;
for (const step of PLAN) {
  const repeats = step.repeats ?? REPEATS;
  for (const profile of step.profiles) {
    for (let i = 1; i <= repeats; i++) {
      n++;
      process.stdout.write(`[${n}/${plannedTotal}] ${step.scenario} ${profile} #${i} ... `);
      restartBrowsers();
      const r = await runOnce(step.scenario, profile);
      r.attempt = i;
      results.push(r);
      console.log(
        `${r.environment ? "ENV" : r.ok ? "pass" : "FAIL"} (${r.seconds}s)` +
          (r.failures.length ? ` :: ${r.failures.join(", ")}` : "")
      );
    }
  }
}

// Attach bundle evidence, pairing each run with the captures it produced.
const capturesDir = `${HERE}captures/`;
let allCaptures = [];
try {
  allCaptures = readdirSync(capturesDir).filter((f) => f.endsWith(".json"));
} catch {
  allCaptures = [];
}
for (const r of results) {
  r.evidence = (r.captures.length ? r.captures : []).map(readBundle);
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

const tested = results.filter((r) => !r.environment);
const byCase = new Map();
for (const r of tested) {
  const key = `${r.scenario} / ${r.profile}`;
  const cur = byCase.get(key) ?? { runs: 0, failed: 0, reasons: new Map(), seconds: [] };
  cur.runs++;
  cur.seconds.push(r.seconds);
  if (!r.ok) {
    cur.failed++;
    for (const f of r.failures) cur.reasons.set(f, (cur.reasons.get(f) ?? 0) + 1);
  }
  byCase.set(key, cur);
}

const lines = [];
lines.push(`# Lab super test`);
lines.push("");
lines.push(`- target: \`${APP}\``);
lines.push(`- started: ${started.toISOString()}`);
lines.push(`- runs: ${results.length} (${tested.length} tested, ${results.length - tested.length} environment)`);
lines.push("");
lines.push(`## Failure rate by case`);
lines.push("");
lines.push(`| case | runs | failed | rate | median s | reasons |`);
lines.push(`| --- | --- | --- | --- | --- | --- |`);
for (const [key, c] of byCase) {
  const median = c.seconds.sort((a, b) => a - b)[Math.floor(c.seconds.length / 2)];
  const reasons = [...c.reasons.entries()].map(([r, k]) => `${r} (${k}x)`).join("; ") || "-";
  lines.push(
    `| ${key} | ${c.runs} | ${c.failed} | ${Math.round((c.failed / c.runs) * 100)}% | ${median} | ${reasons} |`
  );
}
lines.push("");

const failures = tested.filter((r) => !r.ok);
lines.push(`## Failures in detail (${failures.length})`);
lines.push("");
if (failures.length === 0) lines.push("None.");
for (const [i, r] of failures.entries()) {
  lines.push(`### ${i + 1}. ${r.scenario} / ${r.profile} (attempt ${r.attempt}, ${r.seconds}s)`);
  lines.push("");
  lines.push(`**Assertions that failed:** ${r.failures.join(", ") || "(aborted before asserting)"}`);
  lines.push("");
  lines.push("What the run printed:");
  lines.push("");
  lines.push("```");
  lines.push(r.tail);
  lines.push("```");
  lines.push("");
  if (r.evidence.length === 0) {
    lines.push("_No diagnostic bundle captured for this run._");
  } else {
    lines.push("What the app itself recorded:");
    lines.push("");
    for (const e of r.evidence) {
      lines.push("```json");
      lines.push(JSON.stringify(e, null, 1));
      lines.push("```");
    }
  }
  lines.push("");
}

const passes = tested.filter((r) => r.ok && r.evidence.length > 0);
lines.push(`## A healthy run, for comparison`);
lines.push("");
if (passes.length === 0) lines.push("None captured.");
else {
  const p = passes[passes.length - 1];
  lines.push(`\`${p.scenario} / ${p.profile}\`, which passed:`);
  lines.push("");
  for (const e of p.evidence) {
    lines.push("```json");
    lines.push(JSON.stringify(e, null, 1));
    lines.push("```");
  }
}
lines.push("");

mkdirSync(`${HERE}reports/`, { recursive: true });
const stamp = started.toISOString().replace(/[:.]/g, "-");
const md = `${HERE}reports/${stamp}-super.md`;
const json = `${HERE}reports/${stamp}-super.json`;
writeFileSync(md, lines.join("\n"));
writeFileSync(json, JSON.stringify({ started, app: APP, results }, null, 2));

console.log(`\nreport: ${md}`);
console.log(`raw:    ${json}`);
console.log(`\n${failures.length} failure(s) across ${tested.length} tested runs.`);
process.exit(0);
