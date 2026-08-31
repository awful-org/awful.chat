#!/usr/bin/env node
/**
 * Fetch external plugins into frontend/plugins/ at build time, driven by the
 * PLUGIN_SOURCES env - the itzg/docker-minecraft-server model, adapted to a
 * build-time bundle: plugins compile into the app, so fetching happens
 * before `vite build`, and a redeploy is what publishes changes.
 *
 * PLUGIN_SOURCES is a comma/whitespace separated list of:
 *
 *   user/repo@<commit-sha>   pinned. The only form that can be rebuilt later.
 *   user/repo@v1.2           a tag or branch. Builds, but is recorded as not
 *                            reproducible, because either can be moved.
 *   user/repo                the default branch. Needs opt-in, see below.
 *   https://github.com/user/repo   the same, written out in full.
 *   /abs/path or ./rel/path  a local directory, for development.
 *
 * The ref separator is @ or #, and @ is the one to use in an environment
 * variable: a .env file treats # as the start of a comment, so owner/repo#sha
 * arrives here as owner/repo.
 *
 * Each source may contain ONE plugin (manifest.ts at its root) or a PACK
 * (plugin folders at the root or under plugins/). Anything fetched is
 * recorded in plugins/.fetched.json and wiped on the next run, so removing
 * an entry from the env removes the plugin on the next deploy. In-repo
 * plugins (wheel, poll) are never overwritten.
 *
 * Trust model: identical to the app itself - the operator ships this code,
 * unsandboxed, to every user of the instance. Only list sources you trust
 * like your own code, and pin refs for reproducible deploys.
 *
 * A source with no #ref fails the build by default: it fetches HEAD of a
 * third-party repo with no integrity check, and the exact same env value can
 * ship different code on the next build. Set PLUGIN_SOURCES_ALLOW_UNPINNED=1
 * to opt into that anyway. Every fetched source prints its tarball's sha256
 * so an operator can confirm two fetches pulled the same bytes.
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const PLUGINS_DIR = resolve(import.meta.dirname, "../plugins");
const FETCHED_MANIFEST = join(PLUGINS_DIR, ".fetched.json");

function fail(msg) {
  console.error(`[fetch-plugins] ERROR: ${msg}`);
  process.exit(1);
}

function readFetchedList() {
  try {
    const parsed = JSON.parse(readFileSync(FETCHED_MANIFEST, "utf8"));
    if (!Array.isArray(parsed)) return [];
    // Both shapes: a bare list of ids, and the list of provenance records
    // that replaced it. This drives the WIPE, so a reader that understood
    // only the newer shape would wipe nothing on the first build after an
    // upgrade and leave stale plugins installed.
    return parsed
      .map((e) => (typeof e === "string" ? e : e?.id))
      .filter((id) => typeof id === "string" && id.length > 0);
  } catch {
    return [];
  }
}

function pluginIdOf(dir) {
  const manifestPath = join(dir, "manifest.ts");
  if (!existsSync(manifestPath) || !existsSync(join(dir, "index.ts"))) {
    return null;
  }
  const m = readFileSync(manifestPath, "utf8").match(
    /id:\s*["']([a-z0-9-]{2,32})["']/
  );
  return m ? m[1] : null;
}

/**
 * A plugin that reads build-time env puts the instance's own addresses back
 * into the bundle.
 *
 * vite replaces `import.meta.env.VITE_API_URL` with the literal value at
 * build time, so one line in one plugin makes every instance's JavaScript
 * different again - which is exactly what a published build hash exists to
 * rule out, and it is invisible in review because the leak is a value, not
 * a name. This is not hypothetical: steam-roulette did it, and it was only
 * found by fingerprinting a deployed instance and diffing it against a
 * local build of the same commit.
 *
 * `import.meta.env.DEV` and friends are constants of the build mode, not of
 * the instance, so they are fine.
 *
 * Whole-line comments are dropped first, so a plugin can document the
 * hazard - this file's own fix does - without tripping the check. Only
 * whole lines: stripping from a `//` anywhere would eat the rest of a line
 * holding a url, and a leak sharing a line with code would go unseen.
 */
const ENV_LEAK_RE = /import\s*\.\s*meta\s*\.\s*env\s*(?:\.\s*VITE_|\[)/;

function checkNoEnvReads(dir, id) {
  const offenders = [];
  const walk = (d) => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (/\.(ts|js|svelte|mjs)$/.test(entry.name)) {
        const code = readFileSync(full, "utf8")
          .split("\n")
          .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
          .join("\n");
        if (ENV_LEAK_RE.test(code)) {
          offenders.push(full.slice(dir.length + 1));
        }
      }
    }
  };
  walk(dir);
  if (offenders.length) {
    fail(
      `plugin "${id}" reads build-time environment in: ${offenders.join(", ")}\n` +
        `  vite inlines those values, which puts this instance's own addresses ` +
        `into the bundle and makes its build unverifiable.\n` +
        `  Use the host api instead: proxyUrl() from "$lib/plugins/api" for ` +
        `the plugin proxy, or apiUrl() from "$lib/runtime-config".`
    );
  }
}

/** Plugin dirs inside an extracted source: root, root/*, root/plugins/*. */
function findPlugins(root) {
  const candidates = [root];
  for (const base of [root, join(root, "plugins")]) {
    if (!existsSync(base)) continue;
    for (const entry of readdirSync(base, { withFileTypes: true })) {
      if (entry.isDirectory()) candidates.push(join(base, entry.name));
    }
  }
  const found = [];
  for (const dir of candidates) {
    const id = pluginIdOf(dir);
    if (id) found.push({ id, dir });
  }
  return found;
}

async function materialize(source, tmp) {
  if (source.startsWith("/") || source.startsWith("./")) {
    const abs = resolve(source);
    if (!existsSync(abs)) fail(`local source does not exist: ${source}`);
    // The same shape the remote branch returns; the caller destructures it.
    // A directory has no ref and no tarball to hash - it is whatever is on
    // disk right now, which is the point of it.
    return { root: abs, spec: abs, ref: "local", pinned: false, sha256: null };
  }
  let spec = source.replace(/^https:\/\/github\.com\//, "");
  let ref = "HEAD";
  let hasRef = false;
  // Either separator, and @ is the one to reach for in an environment
  // variable. A .env file treats # as the start of a comment, so
  // PLUGIN_SOURCES=owner/repo#sha silently arrives as owner/repo - pinned
  // in the file an operator wrote, unpinned by the time the build sees it,
  // and the build then fails complaining about a pin that is right there.
  // Neither a repo owner nor a repo name can contain @, so this is
  // unambiguous.
  const sep = spec.search(/[#@]/);
  if (sep !== -1) {
    ref = spec.slice(sep + 1);
    spec = spec.slice(0, sep);
    hasRef = true;
  }
  spec = spec.replace(/\.git$/, "").replace(/\/$/, "");
  if (!/^[\w.-]+\/[\w.-]+$/.test(spec)) {
    fail(
      `unrecognized source (want github url, user/repo[@ref], or a path): ${source}`
    );
  }
  // No #ref means "fetch whatever HEAD is right now" - a different build can
  // ship different code from the exact same PLUGIN_SOURCES value, with no
  // integrity check on what came back. Loud by default; opt-in to bypass.
  // Pinned means a commit sha, and nothing else. A tag or a branch can be
  // moved after the fact, so a build that used one cannot be reproduced from
  // its own declaration later - which is what anyone checking the instance
  // reads `pinned` to mean. Such a ref still builds: choosing one is
  // deliberate in a way that fetching a default branch is not. It is
  // recorded honestly and warned about.
  const pinned = /^[0-9a-f]{7,40}$/i.test(ref);
  if (hasRef && !pinned) {
    console.error(
      `[fetch-plugins] WARNING: ${spec}@${ref} is a tag or branch, not a ` +
        `commit sha. It can be moved, so this build records itself as not ` +
        `reproducible and cannot be rebuilt from its own declaration later. ` +
        `Use a sha to pin it.`
    );
  }
  if (!hasRef) {
    console.error(
      `[fetch-plugins] WARNING: ${spec} has no ref - this fetches HEAD of a ` +
        `third-party repo with no integrity check, and the code that ships ` +
        `can change between builds with no diff to review.`
    );
    if (process.env.PLUGIN_SOURCES_ALLOW_UNPINNED !== "1") {
      fail(
        `${spec} has no ref. Pin it to a commit sha: ` +
          `${spec}@<commit-sha>.` +
          `\n  To fetch HEAD anyway, set PLUGIN_SOURCES_ALLOW_UNPINNED=1 ` +
          `(fine for testing; such a build cannot be reproduced by anyone once ` +
          `that branch moves).`
      );
    }
  }
  const url = `https://codeload.github.com/${spec}/tar.gz/${ref}`;
  console.log(`[fetch-plugins] downloading ${spec}@${ref}`);
  const res = await fetch(url);
  if (!res.ok) fail(`download failed (${res.status}) for ${url}`);
  const tarBuf = Buffer.from(await res.arrayBuffer());
  const tarPath = join(tmp, "src.tar.gz");
  writeFileSync(tarPath, tarBuf);
  // Only a tarball by ref is downloaded here (no git clone, no GitHub API
  // call), so there is no commit SHA to resolve for free. The tarball's own
  // sha256 is the next best thing: it lets an operator confirm two fetches
  // of the same ref actually pulled the same bytes.
  const sha256 = createHash("sha256").update(tarBuf).digest("hex");
  console.log(`[fetch-plugins] ${spec}@${ref} tarball sha256: ${sha256}`);
  const out = join(tmp, "x");
  mkdirSync(out);
  // --strip-components=1 drops the repo-name-ref top folder codeload adds.
  execFileSync("tar", ["-xzf", tarPath, "-C", out, "--strip-components=1"]);
  return { root: out, spec, ref, pinned, sha256 };
}

/**
 * What to fetch: the environment if it says anything, otherwise the set
 * committed alongside this script.
 *
 * The committed file is the default because the plugin set decides what code
 * reaches users, and leaving that in a deploy's environment made it
 * invisible: not in any commit, not reviewable, and unknowable to a CI job
 * that wants to publish a hash describing the instance. The env still wins,
 * so trying a plugin out locally needs no commit.
 */
const sources = (process.env.PLUGIN_SOURCES ?? "")
  .split(/[\s,]+/)
  .map((s) => s.trim())
  .filter(Boolean);

// Wipe last run's fetches first: a removed env entry must remove the plugin.
const previouslyFetched = readFetchedList();
for (const id of previouslyFetched) {
  rmSync(join(PLUGINS_DIR, id), { recursive: true, force: true });
}
rmSync(FETCHED_MANIFEST, { force: true });

if (sources.length === 0) {
  console.log("[fetch-plugins] PLUGIN_SOURCES empty - nothing to fetch");
  process.exit(0);
}

const inRepo = new Set(
  readdirSync(PLUGINS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
);

const fetched = [];
for (const source of sources) {
  const tmp = mkdtempSync(join(tmpdir(), "awful-plugin-"));
  try {
    const { root, spec, ref, pinned, sha256 } = await materialize(source, tmp);
    const plugins = findPlugins(root);
    if (plugins.length === 0) {
      fail(`no plugin found in ${source} (need manifest.ts + index.ts)`);
    }
    for (const { id, dir } of plugins) {
      if (inRepo.has(id)) {
        fail(`plugin "${id}" from ${source} collides with a built-in plugin`);
      }
      if (fetched.some((f) => f.id === id)) {
        fail(`plugin "${id}" provided by two sources`);
      }
      checkNoEnvReads(dir, id);
      cpSync(dir, join(PLUGINS_DIR, id), { recursive: true });
      // Provenance, not just the name: what a deployed instance gets asked
      // is WHICH code this plugin is. The tarball sha is the only integrity
      // fact available here - no clone and no API call, so there is no
      // commit sha to resolve for free - and a ref alone is not enough,
      // because a tag or branch can be moved after the fact.
      fetched.push({ id, source: spec, ref, pinned, sha256 });
      if (!existsSync(join(dir, "README.md"))) {
        console.warn(
          `[fetch-plugins] WARNING: ${id} ships no README.md - operators cannot know its requirements`
        );
      }
      console.log(`[fetch-plugins] installed ${id} from ${source}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

writeFileSync(FETCHED_MANIFEST, JSON.stringify(fetched, null, 2));
// NEVER leave ignore rules covering fetched plugins: Tailwind v4's source
// detection honors gitignore rules (any of them - a plugins/.gitignore,
// the repo root's, even .git/info/exclude, and @source does not override),
// so an ignored plugin builds with NONE of its utility classes - unstyled
// strips, default blue range inputs, in every deployed image. Keeping the
// working tree clean is not worth shipping broken CSS; fetched plugins
// simply show as untracked in dev.
rmSync(join(PLUGINS_DIR, ".gitignore"), { force: true });
console.log(`[fetch-plugins] done: ${fetched.length} plugin(s)`);
