/**
 * Tarballs shaped like the ones codeload.github.com serves (git archive): a
 * pax global header naming the commit, then the repo's files under one top
 * folder. Written by hand, so the plugin fetch tests need no git. Test-only.
 */
import { gzipSync } from "node:zlib";

/** One ustar header block, as git archive writes them. */
export function header(name: string, typeflag: string, size: number): Buffer {
  const block = Buffer.alloc(512);
  block.write(name, 0, "latin1");
  block.write(typeflag === "5" ? "0000755\0" : "0000644\0", 100, "latin1");
  block.write("0000000\0", 108, "latin1");
  block.write("0000000\0", 116, "latin1");
  block.write(size.toString(8).padStart(11, "0") + "\0", 124, "latin1");
  // A plausible date: some tars complain about 1970.
  block.write((1_700_000_000).toString(8).padStart(11, "0") + "\0", 136, "latin1");
  block.write("        ", 148, "latin1");
  block.write(typeflag, 156, "latin1");
  block.write("ustar\0" + "00", 257, "latin1");
  let sum = 0;
  for (const b of block) sum += b;
  block.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  return block;
}

export function padded(body: Buffer): Buffer {
  return Buffer.concat([body, Buffer.alloc((512 - (body.length % 512)) % 512)]);
}

/** A pax record: its length counts itself, in bytes. */
export function record(key: string, value: string): string {
  const rest = ` ${key}=${value}\n`;
  const bytes = Buffer.byteLength(rest);
  let length = bytes + 1;
  while (String(length).length + bytes !== length) length += 1;
  return `${length}${rest}`;
}

/** A plugin as small as the fetch accepts: manifest, entry and README. */
export const DICE: Record<string, string> = {
  "manifest.ts": 'export const manifest = { id: "dice", name: "Dice" };\n',
  "index.ts": "export default {};\n",
  "README.md": "# Dice\n",
};

/**
 * A gzipped, codeload-shaped tarball: a pax global header holding
 * `paxRecords` (none when null), then `files` under the `top` folder.
 */
export function tarball(
  paxRecords: string | null,
  files: Record<string, string> = DICE,
  top = "dice-ref"
): Buffer {
  const parts: Buffer[] = [];
  if (paxRecords !== null) {
    const body = Buffer.from(paxRecords);
    parts.push(header("pax_global_header", "g", body.length), padded(body));
  }
  parts.push(header(`${top}/`, "5", 0));
  for (const [name, text] of Object.entries(files)) {
    const body = Buffer.from(text);
    parts.push(header(`${top}/${name}`, "0", body.length), padded(body));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}
