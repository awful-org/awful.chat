/**
 * Write dist/.well-known/awful-build.json - what this build says it is.
 *
 * The app is static, so nothing can answer this at request time; it has to
 * be baked in when the bundle is made. It is a CLAIM, not proof: an operator
 * can write anything here. Its job is to name which published build a
 * verifier should compare the served bytes against, and a false claim only
 * makes that comparison fail sooner.
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { resolveCommit, resolveRepository } from "./git-commit.mjs";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const DIST = join(ROOT, "dist");
const PLUGINS_DIR = join(ROOT, "plugins");

if (!existsSync(DIST)) {
  console.error("[build-info] no dist/ - run this after vite build");
  process.exit(1);
}

function readJson(path, fallback) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return fallback;
  }
}

const fetched = readJson(join(PLUGINS_DIR, ".fetched.json"), []);
const fetchedById = new Map(
  fetched
    .map((e) => (typeof e === "string" ? { id: e } : e))
    .filter((e) => e?.id)
    .map((e) => [e.id, e])
);

/**
 * Every plugin in the build, built-in and fetched alike.
 *
 * Read off the filesystem rather than from a kept list, because the question
 * is what SHIPPED - a fetched plugin that fetch-plugins failed to record
 * would otherwise be invisible in exactly the declaration meant to disclose
 * it.
 */
const plugins = existsSync(PLUGINS_DIR)
  ? readdirSync(PLUGINS_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .filter((id) => existsSync(join(PLUGINS_DIR, id, "manifest.ts")))
      .sort()
      .map((id) => {
        const src = fetchedById.get(id);
        return src
          ? {
              id,
              origin: "fetched",
              source: src.source ?? null,
              ref: src.ref ?? null,
              pinned: src.pinned ?? null,
              // The tarball's sha256. A fetch is a codeload download - no
              // clone, no API call - so there is no commit sha to be had for
              // free, and a ref alone is not enough because a tag can move.
              sha256: src.sha256 ?? null,
            }
          : // "in-tree", not "built-in". All this knows is that the folder
            // was in plugins/ at build time and fetch-plugins did not record
            // it. In a CI or docker build that means a genuine built-in,
            // because fetch runs there and records what it pulled. In a
            // working tree it can also be a leftover fetched copy somebody
            // synced by hand - and claiming "built-in" for that would be the
            // declaration telling a lie of exactly the kind it exists to
            // prevent.
            { id, origin: "in-tree" };
      })
  : [];

const pkg = readJson(join(ROOT, "package.json"), {});
const info = {
  schema: "awful-build/1",
  // Pre-1.0 this is 0.0.0 on purpose: there are no releases yet, so the
  // commit is the only identity a build actually has.
  version: pkg.version ?? null,
  // Where to READ the code, not just which commit. A fork serves its own
  // source, and a commit with no repository beside it names nothing.
  repository: resolveRepository() || null,
  // The whole sha, not the seven characters the bundle carries: this
  // is the key somebody looks a published build hash up by.
  commit: resolveCommit({ full: true }) || null,
  builtAt: new Date().toISOString(),
  plugins,
};

mkdirSync(join(DIST, ".well-known"), { recursive: true });
writeFileSync(
  join(DIST, ".well-known", "awful-build.json"),
  JSON.stringify(info, null, 2) + "\n"
);
console.log(
  `[build-info] declared commit ${info.commit ?? "(none)"} and ${
    plugins.length
  } plugin(s)`
);
