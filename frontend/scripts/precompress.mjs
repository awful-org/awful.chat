/**
 * Writes a gzip copy next to every file nginx would compress, for its
 * gzip_static (frontend/nginx.conf). Run on dist/ by the Dockerfile.
 *
 * nginx otherwise compresses on the fly at gzip level 1, for every cold load
 * and every service worker update: a bundle about 15% larger than it needs to
 * be, and CPU on a box shared with the relay and the SFU - the 8 MB DTLN
 * worklet alone took about 200 ms per request. Level 9 here costs that once,
 * at build time.
 *
 * What is left out matters as much:
 *   - index.html: nginx rewrites its meta tags for invite links (/r/) with
 *     sub_filter, which cannot see into a precompressed copy.
 *   - JSON: config.json and whats-new.json are written when the container
 *     starts, and a copy from the build would be served instead of them.
 *   - small files (under nginx's gzip_min_length) and anything that does not
 *     come out smaller.
 *
 * Deterministic: no name or timestamp in the gzip header, so the image
 * builds the same bytes twice.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { constants, gzipSync } from "node:zlib";

/** The gzip_types of nginx.conf, by extension, minus JSON (see above). */
const TYPES = new Set([".js", ".mjs", ".css", ".txt", ".svg", ".xml"]);
/** nginx.conf's gzip_min_length. */
const MIN_BYTES = 1024;

export function precompress(dir) {
  let files = 0;
  let before = 0;
  let after = 0;
  const walk = (at) => {
    for (const entry of readdirSync(at, { withFileTypes: true })) {
      const path = join(at, entry.name);
      if (entry.isDirectory()) {
        walk(path);
        continue;
      }
      if (!entry.isFile() || !TYPES.has(extname(entry.name))) continue;
      const body = readFileSync(path);
      if (body.length < MIN_BYTES) continue;
      const packed = gzipSync(body, { level: constants.Z_BEST_COMPRESSION });
      if (packed.length >= body.length) continue;
      writeFileSync(`${path}.gz`, packed);
      files++;
      before += body.length;
      after += packed.length;
    }
  };
  walk(resolve(dir));
  return { files, before, after };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const dir = process.argv[2] ?? "dist";
  if (!statSync(dir, { throwIfNoEntry: false })?.isDirectory()) {
    console.error(`[precompress] no ${dir}/ - run this after the build`);
    process.exit(1);
  }
  const { files, before, after } = precompress(dir);
  const mb = (n) => (n / 1e6).toFixed(1);
  console.log(`[precompress] ${files} files, ${mb(before)} MB -> ${mb(after)} MB gzip -9`);
}
