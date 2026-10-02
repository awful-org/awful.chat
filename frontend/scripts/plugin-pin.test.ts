import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs, no types
import { refKind, tarballCommit } from "./plugin-pin.mjs";
import { header, padded, record, tarball } from "./tar-fixture";

const SHA = "b8d8061f4b28fbe374dadfbacce7ae6b47a45d87";
const OTHER = "9e806dc5" + "0".repeat(32);

describe("what a ref pins", () => {
  it("takes only a whole commit sha as a pin", () => {
    expect(refKind(SHA, true)).toBe("sha");
    expect(refKind(SHA.toUpperCase(), true)).toBe("sha");
  });

  // The finding: d00d9db was recorded as pinned, and git resolves a branch or
  // tag of that name before the commit it abbreviates.
  it("does not take an abbreviated sha for one", () => {
    expect(refKind("d00d9db", true)).toBe("short-sha");
    expect(refKind(SHA.slice(0, 39), true)).toBe("short-sha");
    // git resolves an abbreviation from 4 characters, so the rule starts there.
    expect(refKind("d00d", true)).toBe("short-sha");
    expect(refKind("2024", true)).toBe("short-sha");
  });

  it("tells tags, branches and a missing ref apart", () => {
    expect(refKind("v1.2", true)).toBe("name");
    expect(refKind("main", true)).toBe("name");
    expect(refKind("d00d9dbz", true)).toBe("name");
    // Too short to be anyone's abbreviation: just a name.
    expect(refKind("abc", true)).toBe("name");
    expect(refKind("HEAD", false)).toBe("none");
  });
});

describe("the commit a tarball names", () => {
  it("reads git archive's pax comment", () => {
    expect(tarballCommit(tarball(record("comment", SHA)))).toBe(SHA);
  });

  it("finds it past other records", () => {
    const records = record("path", "dîce/ünïcode-padding") + record("comment", OTHER);
    expect(tarballCommit(tarball(records))).toBe(OTHER);
  });

  // What a swapped tarball looks like to the build: it names ITS commit, so
  // comparing that to the pin is what catches the swap.
  it("reports the commit that came back, not the one asked for", () => {
    const swapped = tarball(record("comment", OTHER));
    expect(tarballCommit(swapped)).not.toBe(SHA);
  });

  it("is null when the archive names no commit", () => {
    expect(tarballCommit(tarball(null))).toBeNull();
    expect(tarballCommit(tarball(record("comment", "not-a-sha")))).toBeNull();
    expect(tarballCommit(tarball(record("mtime", "1700000000")))).toBeNull();
    expect(tarballCommit(Buffer.from("not a tarball"))).toBeNull();
    expect(tarballCommit(gzipSync(Buffer.alloc(100)))).toBeNull();
  });

  it("only inflates the start of a large archive", () => {
    const pax = Buffer.from(record("comment", SHA));
    const big = Buffer.concat([
      header("pax_global_header", "g", pax.length),
      padded(pax),
      Buffer.alloc(8 * 1024 * 1024, 7),
    ]);
    expect(tarballCommit(gzipSync(big))).toBe(SHA);
  });
});
