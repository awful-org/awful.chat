/**
 * The commit a build came from, without needing git on PATH.
 *
 * `git rev-parse` cannot answer inside the docker build: node:alpine ships
 * no git binary. Reading the refs directly costs about twenty lines and
 * works anywhere the repository is present, which includes the image build -
 * the frontend's build context is the repo root and the Dockerfile copies
 * .git in. So no deployment has to supply the commit by hand.
 *
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

/** Seven characters in the bundle; the declaration carries the whole sha. */
const SHORT = 7;

/** Resolve a ref name to a sha, refs/ file first, then packed-refs. */
function readRef(gitDir, ref) {
  const loose = join(gitDir, ref);
  if (existsSync(loose)) {
    const sha = readFileSync(loose, "utf8").trim();
    if (/^[0-9a-f]{40}$/i.test(sha)) return sha;
  }
  // A repository that has been gc'd (or cloned) keeps its refs in one file
  // instead of one file each, so the loose lookup above finds nothing.
  const packed = join(gitDir, "packed-refs");
  if (!existsSync(packed)) return null;
  for (const line of readFileSync(packed, "utf8").split("\n")) {
    if (!line || line.startsWith("#") || line.startsWith("^")) continue;
    const [sha, name] = line.trim().split(/\s+/);
    if (name === ref && /^[0-9a-f]{40}$/i.test(sha)) return sha;
  }
  return null;
}

/**
 * @param {object} [opts]
 * @param {boolean} [opts.full] the whole sha rather than seven characters.
 *   Used for the published declaration, which is a lookup key and wants to
 *   be unambiguous; the bundle takes the short form so it stays stable
 *   across the different spellings a deploy might pass.
 * @param {string} [opts.gitDir] the .git directory; defaults to the repo
 *   root's, where it sits both in a checkout and in the image build.
 * @returns {string} the commit, or "" when there is nothing to read - an
 *   empty commit is a normal answer and the UI just omits it.
 */
export function resolveCommit({
  full = false,
  gitDir = resolve(import.meta.dirname, "../../.git"),
} = {}) {
  const cut = (sha) => (full ? sha : sha.slice(0, SHORT));
  try {
    const head = readFileSync(join(gitDir, "HEAD"), "utf8").trim();
    // Detached HEAD (what a CI checkout and a tag deploy both look like)
    // holds the sha itself; anything else points at a ref.
    if (/^[0-9a-f]{40}$/i.test(head)) return cut(head);
    const m = head.match(/^ref:\s*(\S+)$/);
    if (!m) return "";
    return cut(readRef(gitDir, m[1]) ?? "");
  } catch {
    return "";
  }
}

/**
 * Which repository this build came from, as "host/owner/name".
 *
 * The commit alone does not identify code: a fork has its own commits, and
 * a declaration saying "3482f4d" while pointing at nothing is a number
 * anybody can write down. Fetched plugins have recorded their source repo
 * from the start; the app itself was the one part that never said.
 *
 * Read from the clone's own origin, so a fork declares itself with no
 * configuration, the same way the commit is.
 *
 * ANY credentials in the url are dropped. A clone made with a token in the
 * remote ("https://x-access-token:ghp_...@github.com/o/r") would otherwise
 * publish it to every visitor of the instance, which is a far worse bug
 * than the one this field exists to fix.
 */
export function resolveRepository({
  gitDir = resolve(import.meta.dirname, "../../.git"),
} = {}) {
  try {
    const config = readFileSync(join(gitDir, "config"), "utf8");
    // The first url under [remote "origin"], not merely the first url in the
    // file: a fork commonly adds an "upstream" remote, and reporting that
    // would name the repository this build did NOT come from.
    const section = config.split(/^\[/m).find((s) => /^remote "origin"\]/.test(s));
    const m = section?.match(/^\s*url\s*=\s*(\S+)/m);
    return m ? normalizeRemote(m[1]) : "";
  } catch {
    return "";
  }
}

/** scp-style and url remotes to a bare "host/owner/name". */
function normalizeRemote(raw) {
  let s = raw.trim().replace(/\.git$/, "");
  const scp = s.match(/^[^@/]+@([^:]+):(.+)$/); // git@github.com:owner/repo
  if (scp) return `${scp[1]}/${scp[2]}`;
  try {
    const url = new URL(s);
    // Drops user:password entirely - see the note above.
    return `${url.host}${url.pathname}`.replace(/\/+$/, "");
  } catch {
    return s;
  }
}
