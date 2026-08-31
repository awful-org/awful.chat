import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
// @ts-expect-error - plain .mjs, no types
import { resolveCommit } from "./git-commit.mjs";

const SHA = "0123456789abcdef0123456789abcdef01234567";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gitdir-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function head(contents: string) {
  writeFileSync(join(dir, "HEAD"), contents);
}

describe("resolveCommit", () => {
  it("reads a loose ref", () => {
    head("ref: refs/heads/dev\n");
    mkdirSync(join(dir, "refs/heads"), { recursive: true });
    writeFileSync(join(dir, "refs/heads/dev"), `${SHA}\n`);
    expect(resolveCommit({ gitDir: dir })).toBe("0123456");
    expect(resolveCommit({ gitDir: dir, full: true })).toBe(SHA);
  });

  // What a fresh clone looks like, which is what the deploy host has: git
  // packs the refs into one file instead of one file each, so a reader that
  // only knew about refs/heads/* would come up empty on every deploy.
  it("falls back to packed-refs", () => {
    head("ref: refs/heads/dev\n");
    writeFileSync(
      join(dir, "packed-refs"),
      [
        "# pack-refs with: peeled fully-peeled sorted",
        `${"f".repeat(40)} refs/heads/main`,
        `${SHA} refs/heads/dev`,
        `${"a".repeat(40)} refs/tags/v1`,
        // A peeled tag line. Taking this as the ref above it would report
        // the tag's commit for the branch.
        `^${"b".repeat(40)}`,
      ].join("\n")
    );
    expect(resolveCommit({ gitDir: dir, full: true })).toBe(SHA);
  });

  // A CI checkout and a deploy of a tag are both detached.
  it("reads a detached HEAD directly", () => {
    head(`${SHA}\n`);
    expect(resolveCommit({ gitDir: dir })).toBe("0123456");
  });

  it("returns empty rather than throwing when there is nothing to read", () => {
    expect(resolveCommit({ gitDir: join(dir, "nope") })).toBe("");
    head("ref: refs/heads/gone\n");
    expect(resolveCommit({ gitDir: dir })).toBe("");
  });
});

// @ts-expect-error - plain .mjs, no types
import { resolveRepository } from "./git-commit.mjs";

function config(body: string) {
  writeFileSync(join(dir, "config"), body);
}

describe("resolveRepository", () => {
  it("normalises an scp-style remote", () => {
    config('[remote "origin"]\n\turl = git@github.com:awful-org/awful.chat.git\n');
    expect(resolveRepository({ gitDir: dir })).toBe("github.com/awful-org/awful.chat");
  });

  it("normalises an https remote", () => {
    config('[remote "origin"]\n\turl = https://github.com/someone/my-fork.git\n');
    expect(resolveRepository({ gitDir: dir })).toBe("github.com/someone/my-fork");
  });

  // A clone made with a token in the remote would otherwise publish it to
  // every visitor of the instance - a far worse bug than the one this field
  // exists to fix.
  it("never publishes credentials from the remote url", () => {
    config(
      '[remote "origin"]\n\turl = https://x-access-token:ghp_SECRETVALUE@github.com/o/r.git\n'
    );
    const out = resolveRepository({ gitDir: dir });
    expect(out).toBe("github.com/o/r");
    expect(out).not.toContain("ghp_");
    expect(out).not.toContain("x-access-token");
  });

  // A fork usually adds an "upstream" remote. Reporting that would name the
  // repository this build did NOT come from - the exact confusion the field
  // is meant to remove.
  it("takes origin, not whichever remote comes first", () => {
    config(
      '[remote "upstream"]\n\turl = git@github.com:awful-org/awful.chat.git\n' +
        '[remote "origin"]\n\turl = git@github.com:someone/my-fork.git\n'
    );
    expect(resolveRepository({ gitDir: dir })).toBe("github.com/someone/my-fork");
  });

  it("returns empty when there is no remote", () => {
    config("[core]\n\tbare = false\n");
    expect(resolveRepository({ gitDir: dir })).toBe("");
    expect(resolveRepository({ gitDir: join(dir, "nope") })).toBe("");
  });
});
