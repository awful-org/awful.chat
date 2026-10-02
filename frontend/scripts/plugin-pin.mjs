/**
 * What a PLUGIN_SOURCES ref pins, and whether a downloaded tarball is that
 * commit. Pure, so fetch-plugins.mjs can lean on it and a test can too.
 */
import { constants, gunzipSync } from "node:zlib";

/** A whole commit sha: the only ref git always reads as an object name. */
const FULL_SHA = /^[0-9a-f]{40}$/i;
/** Hex short of a whole sha: what an abbreviated commit looks like. */
const SHORT_SHA = /^[0-9a-f]{7,39}$/i;

/**
 * "sha" for a whole commit sha - the only pin. "short-sha" for an
 * abbreviation, which is not one: git resolves a branch or tag of the same
 * name before it, and a repo recreated under the same name can grow a new
 * commit sharing the prefix in seconds. "name" for a tag or branch, "none"
 * when the source names no ref at all.
 *
 * @param {string} ref
 * @param {boolean} hasRef
 * @returns {"sha" | "short-sha" | "name" | "none"}
 */
export function refKind(ref, hasRef) {
  if (!hasRef) return "none";
  if (FULL_SHA.test(ref)) return "sha";
  if (SHORT_SHA.test(ref)) return "short-sha";
  return "name";
}

/**
 * The commit a GitHub tarball says it is. git archive writes it into a pax
 * global header, `comment=<sha>`, ahead of the first file - which is what
 * `git get-tar-commit-id` reads. Null when the archive carries none.
 *
 * Only the start of the archive is inflated: the header is its first block,
 * and a tarball is whatever the far end chose to send.
 *
 * @param {Buffer} tarGz
 * @returns {string | null} the sha, lower case
 */
export function tarballCommit(tarGz) {
  let tar;
  try {
    tar = gunzipSync(tarGz.subarray(0, 64 * 1024), {
      finishFlush: constants.Z_SYNC_FLUSH,
    });
  } catch {
    return null;
  }
  if (tar.length < 512 || tar[156] !== 0x67 /* "g" */) return null;
  const size = parseInt(
    tar.subarray(124, 136).toString("latin1").replace(/\0.*$/s, "").trim(),
    8
  );
  if (!Number.isSafeInteger(size) || size <= 0 || 512 + size > tar.length) {
    return null;
  }
  // Records are "<length> <key>=<value>\n", the length counting the whole
  // record in bytes - so this walks bytes, not decoded characters.
  const records = tar.subarray(512, 512 + size);
  let pos = 0;
  while (pos < records.length) {
    const space = records.indexOf(0x20, pos);
    if (space === -1) break;
    const length = Number(records.subarray(pos, space).toString("latin1"));
    if (
      !Number.isSafeInteger(length) ||
      length <= space - pos + 1 ||
      pos + length > records.length
    ) {
      break;
    }
    const record = records.subarray(space + 1, pos + length - 1).toString("utf8");
    const eq = record.indexOf("=");
    if (eq > 0 && record.slice(0, eq) === "comment") {
      const value = record.slice(eq + 1);
      return FULL_SHA.test(value) ? value.toLowerCase() : null;
    }
    pos += length;
  }
  return null;
}
