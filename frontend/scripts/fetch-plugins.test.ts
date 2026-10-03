import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { record, tarball } from "./tar-fixture";

/**
 * fetch-plugins.mjs run for real, against a stand-in for codeload: what it
 * refuses, what it installs, and what it records. A copy runs, so what it
 * installs lands in the copy's plugins/ and never in this repo's.
 */
const HERE = fileURLToPath(new URL(".", import.meta.url));
const PIN = "b8d8061f4b28fbe374dadfbacce7ae6b47a45d87";
const SHADOW = "9e806dc5" + "1".repeat(32);

/** Serves <CODELOAD_DIR>/<ref>.tar.gz for any repo, else a 404; logs each ask. */
const CODELOAD = `
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
const root = process.env.CODELOAD_DIR;
globalThis.fetch = async (url) => {
  appendFileSync(join(root, "requests.log"), String(url) + "\\n");
  const ref = /^https:\\/\\/codeload\\.github\\.com\\/[^/]+\\/[^/]+\\/tar\\.gz\\/(.+)$/.exec(String(url))?.[1];
  const file = ref && join(root, ref + ".tar.gz");
  return file && existsSync(file)
    ? new Response(readFileSync(file))
    : new Response("not found", { status: 404 });
};
`;

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "fetch-plugins-"));
  for (const sub of ["scripts", "plugins", "codeload", "tmp"]) mkdirSync(join(dir, sub));
  for (const file of ["fetch-plugins.mjs", "plugin-pin.mjs"]) {
    copyFileSync(join(HERE, file), join(dir, "scripts", file));
  }
  writeFileSync(join(dir, "codeload.mjs"), CODELOAD);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** What codeload answers for `ref`: a tarball naming `commit` (none if null). */
function serve(ref: string, commit: string | null) {
  writeFileSync(join(dir, "codeload", `${ref}.tar.gz`), tarball(commit && record("comment", commit)));
}

function fetchPlugins(sources: string, env: Record<string, string> = {}) {
  const run = spawnSync(
    process.execPath,
    ["--import", pathToFileURL(join(dir, "codeload.mjs")).href, join(dir, "scripts", "fetch-plugins.mjs")],
    {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: join(dir, "tmp"),
        CODELOAD_DIR: join(dir, "codeload"),
        PLUGIN_SOURCES: sources,
        ...env,
      },
    }
  );
  return { status: run.status, log: `${run.stdout}${run.stderr}` };
}

const installed = () => existsSync(join(dir, "plugins", "dice", "manifest.ts"));
const recorded = () => JSON.parse(readFileSync(join(dir, "plugins", ".fetched.json"), "utf8"));
const asked = () => {
  const log = join(dir, "codeload", "requests.log");
  return existsSync(log) ? readFileSync(log, "utf8").trim().split("\n") : [];
};

describe("fetch-plugins", () => {
  it("installs a whole-sha pin when the tarball is that commit, and records it pinned", () => {
    serve(PIN, PIN);
    const run = fetchPlugins(`owner/dice@${PIN}`);
    expect(run.status, run.log).toBe(0);
    expect(run.log).toContain(`is commit ${PIN}`);
    expect(installed()).toBe(true);
    expect(recorded()).toEqual([
      { id: "dice", source: "owner/dice", ref: PIN, pinned: true, sha256: expect.stringMatching(/^[0-9a-f]{64}$/) },
    ]);
  });

  // S10.2: the ref was fetched by name and whatever came back was built.
  it("refuses a tarball that is another commit than the pin", () => {
    serve(PIN, SHADOW);
    const run = fetchPlugins(`owner/dice@${PIN}`);
    expect(run.status).toBe(1);
    expect(run.log).toContain(`is commit ${SHADOW}, not the pinned one`);
    expect(installed()).toBe(false);
  });

  it("refuses a whole-sha pin whose tarball names no commit", () => {
    serve(PIN, null);
    const run = fetchPlugins(`owner/dice@${PIN}`);
    expect(run.status).toBe(1);
    expect(run.log).toContain("names no commit");
    expect(installed()).toBe(false);
  });

  // An abbreviation pins nothing: git resolves a branch or tag of that name
  // first, and the build declaration still said pinned.
  it.each(["d00d9db", "d00d"])("refuses the abbreviated sha %s before fetching anything", (ref) => {
    serve(ref, SHADOW);
    const run = fetchPlugins(`owner/dice@${ref}`);
    expect(run.status).toBe(1);
    expect(run.log).toContain("is not a whole commit sha");
    expect(asked()).toEqual([]);
    expect(installed()).toBe(false);
  });

  it("builds an abbreviated sha only when opted in, recorded unpinned, saying what it got", () => {
    serve("d00d9db", SHADOW);
    const run = fetchPlugins("owner/dice@d00d9db", { PLUGIN_SOURCES_ALLOW_UNPINNED: "1" });
    expect(run.status, run.log).toBe(0);
    expect(run.log).toContain(`is commit ${SHADOW}`);
    expect(recorded()).toMatchObject([{ id: "dice", ref: "d00d9db", pinned: false }]);
  });

  it("builds a tag with a warning, recorded unpinned", () => {
    serve("v1.2", SHADOW);
    const run = fetchPlugins("owner/dice@v1.2");
    expect(run.status, run.log).toBe(0);
    expect(run.log).toContain("is a tag or branch");
    expect(recorded()).toMatchObject([{ id: "dice", ref: "v1.2", pinned: false }]);
  });
});
