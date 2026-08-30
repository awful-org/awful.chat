import { describe, expect, it } from "vitest";
import { assessFile, extensionOf, mediaErrorMessage } from "./playback";

describe("extensionOf", () => {
  it("lowercases and strips the leading dot", () => {
    expect(extensionOf("Episode.01.MKV")).toBe("mkv");
  });

  it("returns empty for a filename with no extension", () => {
    expect(extensionOf("episode01")).toBe("");
  });
});

describe("assessFile", () => {
  it("verdicts Matroska containers as unplayable, by name", () => {
    for (const name of ["episode.mkv", "EPISODE.MKV", "ep01.mka", "ep01.mks"]) {
      const result = assessFile(name);
      expect(result.verdict).toBe("unplayable");
      expect(result.reason).toMatch(/matroska/i);
    }
  });

  it("flags an HEVC/10-bit-named file as risky, not unplayable - the browser gets the final say", () => {
    for (const name of ["episode.hevc.mp4", "episode.h265.mp4", "episode.10bit.mp4", "episode.Hi10P.mkv"]) {
      const result = assessFile(name);
      expect(result.verdict === "unplayable" || result.verdict === "risky").toBe(true);
    }
    // A risky hint on a container that would actually load:
    const risky = assessFile("episode.hevc.mp4");
    expect(risky.verdict).toBe("risky");
    expect(risky.reason).toMatch(/hevc|10-bit/i);
  });

  it("gives an unremarkable mp4 no verdict at all - let the browser try", () => {
    const result = assessFile("episode01.mp4");
    expect(result.verdict).toBe("unknown");
    expect(result.reason).toBeNull();
  });
});

describe("mediaErrorMessage", () => {
  it("maps every MediaError code to one plain sentence", () => {
    expect(mediaErrorMessage(1)).toMatch(/aborted/i);
    expect(mediaErrorMessage(2)).toMatch(/network|file-access/i);
    expect(mediaErrorMessage(3)).toMatch(/decoding failed/i);
    expect(mediaErrorMessage(4)).toMatch(/does not support/i);
  });

  it("falls back to a plain sentence for an unknown or missing code", () => {
    expect(mediaErrorMessage(99)).toMatch(/unknown reason/i);
    expect(mediaErrorMessage(null)).toMatch(/unknown reason/i);
    expect(mediaErrorMessage(undefined)).toMatch(/unknown reason/i);
  });
});
