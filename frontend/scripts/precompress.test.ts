import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs, no types
import { precompress } from "./precompress.mjs";

let dist: string;
beforeEach(() => {
  dist = mkdtempSync(join(tmpdir(), "dist-"));
  mkdirSync(join(dist, "assets/langs"), { recursive: true });
});
afterEach(() => rmSync(dist, { recursive: true, force: true }));

/** Text that compresses, like a bundle does. */
const text = (n: number) => "export const a = 'awful';\n".repeat(Math.ceil(n / 26)).slice(0, n);

function file(path: string, body: string | Buffer) {
  writeFileSync(join(dist, path), body);
}

describe("precompress", () => {
  // nginx compressed every cold load's JavaScript on the fly at level 1, on
  // a box it shares with the relay and the SFU: the 8 MB worklet alone cost
  // about 200 ms of CPU per request.
  it("writes a .gz beside each script, stylesheet and text file nginx would compress", () => {
    file("assets/index-a.js", text(50_000));
    file("assets/index-b.css", text(20_000));
    file("assets/langs/rust-c.js", text(9_000));
    file("audio-worklet.js", text(80_000));
    file("third-party-notices.txt", text(30_000));
    file("logo.svg", text(4_000));
    precompress(dist);
    for (const path of [
      "assets/index-a.js",
      "assets/index-b.css",
      "assets/langs/rust-c.js",
      "audio-worklet.js",
      "third-party-notices.txt",
      "logo.svg",
    ]) {
      const original = readFileSync(join(dist, path));
      const packed = readFileSync(join(dist, `${path}.gz`));
      expect(packed.length, path).toBeLessThan(original.length);
      expect(gunzipSync(packed).equals(original), path).toBe(true);
    }
  });

  // nginx rewrites index.html's meta tags for /r/ with sub_filter, which
  // cannot see into a precompressed copy: with an index.html.gz, invite
  // links would get the homepage's preview card.
  it("never precompresses index.html", () => {
    file("index.html", `<!doctype html>${text(20_000)}`);
    precompress(dist);
    expect(existsSync(join(dist, "index.html.gz"))).toBe(false);
  });

  // config.json and whats-new.json are written when the container starts; a
  // .gz from the build would serve stale ones. Images do not compress.
  it("leaves out JSON, images, small files and anything already compressed", () => {
    file("manifest.json", text(5_000));
    file("og.png", Buffer.alloc(5_000, 7));
    file("assets/tiny-d.js", text(500));
    file("assets/index-a.js", text(50_000));
    precompress(dist);
    precompress(dist);
    for (const path of ["manifest.json", "og.png", "assets/tiny-d.js", "assets/index-a.js.gz"]) {
      expect(existsSync(join(dist, `${path}.gz`)), path).toBe(false);
    }
  });

  // The image is fingerprinted and must build the same bytes twice.
  it("writes the same bytes every time", () => {
    file("assets/index-a.js", text(50_000));
    precompress(dist);
    const first = readFileSync(join(dist, "assets/index-a.js.gz"));
    rmSync(join(dist, "assets/index-a.js.gz"));
    precompress(dist);
    expect(readFileSync(join(dist, "assets/index-a.js.gz")).equals(first)).toBe(true);
  });
});
