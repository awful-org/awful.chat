import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs, no types
import { refKind, tarballCommit } from "./plugin-pin.mjs";

const SHA = "b8d8061f4b28fbe374dadfbacce7ae6b47a45d87";
const OTHER = "9e806dc5" + "0".repeat(32);

/** One ustar header block, as git archive writes them. */
function header(name: string, typeflag: string, size: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, "latin1");
  block.write("0000666\0", 100, "latin1");
  block.write("0000000\0", 108, "latin1");
  block.write("0000000\0", 116, "latin1");
  block.write(size.toString(8).padStart(11, "0") + "\0", 124, "latin1");
  block.write("00000000000\0", 136, "latin1");
  block.write("        ", 148, "latin1");
  block.write(typeflag, 156, "latin1");
  block.write("ustar\0" + "00", 257, "latin1");
  let sum = 0;
  for (const b of block) sum += b;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return block;
}

function padded(body: Buffer): Buffer {
  return Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

/** A pax record: its length counts itself, in bytes. */
function record(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  const bytes = Buffer.byteLength(rest);
  let length = bytes + 1;
  while (String(length).length + bytes !== length) length += 1;
  return `${length}${rest}`;
}

/** A codeload-shaped tarball: pax global header (unless null), one file. */
function tarball(paxRecords: string | null): Buffer {
  const file = Buffer.from('export const manifest = { id: "dice" };\n');
  const parts: Buffer[] = [];
  if (paxRecords !== null) {
    const body = Buffer.from(paxRecords);
    parts.push(header("pax_global_header", "g", body.length), padded(body));
  }
  parts.push(header("dice-ref/manifest.ts", "0", file.length), padded(file));
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}

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
  });

  it("tells tags, branches and a missing ref apart", () => {
    expect(refKind("v1.2", true)).toBe("name");
    expect(refKind("main", true)).toBe("name");
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
