import { describe, it, expect } from "vitest";
import { buildShareOptions, classifyShareAudio } from "./share-audio";

/**
 * Minimal MediaTrackSettings builders. Only the fields classifyShareAudio
 * reads are meaningful; everything else on the real interface is optional.
 */
function video(displaySurface?: string): MediaTrackSettings {
  return { displaySurface };
}
function audio(restrictOwnAudio?: boolean): MediaTrackSettings {
  return { restrictOwnAudio };
}

describe("buildShareOptions", () => {
  // Every member the research's recommended object requires, regardless of
  // which audio branch fires. A silently-dropped member is exactly the kind
  // of regression this test exists to catch.
  const REQUIRED_KEYS = [
    "video",
    "audio",
    "windowAudio",
    "systemAudio",
    "monitorTypeSurfaces",
    "selfBrowserSurface",
    "surfaceSwitching",
    "audioSelection",
  ] as const;

  it("never omits a member the research requires, with restrictOwnAudio supported", () => {
    const options = buildShareOptions({ restrictOwnAudio: true });
    for (const key of REQUIRED_KEYS) {
      expect(options).toHaveProperty(key);
    }
    expect(options.windowAudio).toBe("window");
    expect(options.systemAudio).toBe("include");
    expect(options.monitorTypeSurfaces).toBe("include");
    expect(options.selfBrowserSurface).toBe("exclude");
    expect(options.surfaceSwitching).toBe("include");
    expect(options.audioSelection).toBe("preferred");
    expect(options.video).toEqual({
      displaySurface: "window",
      frameRate: { ideal: 30 },
    });
  });

  it("never omits a member the research requires, without restrictOwnAudio support", () => {
    const options = buildShareOptions({ restrictOwnAudio: false });
    for (const key of REQUIRED_KEYS) {
      expect(options).toHaveProperty(key);
    }
    // The picker-shaping members do not depend on restrictOwnAudio support.
    expect(options.windowAudio).toBe("window");
    expect(options.systemAudio).toBe("include");
    expect(options.monitorTypeSurfaces).toBe("include");
    expect(options.selfBrowserSurface).toBe("exclude");
    expect(options.surfaceSwitching).toBe("include");
    expect(options.audioSelection).toBe("preferred");
  });

  it("requests verbatim stereo audio plus restrictOwnAudio when the platform reports support", () => {
    const options = buildShareOptions({ restrictOwnAudio: true });
    expect(options.audio).toEqual({
      restrictOwnAudio: true,
      echoCancellation: false,
      noiseSuppression: false,
      autoGainControl: false,
      channelCount: 2,
      sampleRate: 48000,
    });
  });

  it("falls back to echo-cancelled mono when restrictOwnAudio is unsupported (Chrome 137-141 style)", () => {
    const options = buildShareOptions({ restrictOwnAudio: false });
    expect(options.audio).toEqual({
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1,
    });
  });

  it("still requests restrictOwnAudio on Linux, which reports support it can never honour", () => {
    // getSupportedConstraints().restrictOwnAudio is hardcoded true in the
    // IDL on every engine that recognises the name, including Linux. There
    // is no pre-picker way to tell the lie apart from the truth, so
    // buildShareOptions trusts it - and classifyShareAudio catches the lie
    // afterwards (see the Linux case below).
    const options = buildShareOptions({ restrictOwnAudio: true });
    expect(options.audio).toMatchObject({ restrictOwnAudio: true });
  });
});

describe("classifyShareAudio", () => {
  it("Windows 11 + Chrome 146+: window share with genuine per-application audio", () => {
    const verdict = classifyShareAudio(video("window"), audio(true));
    expect(verdict.kind).toBe("application-scoped");
  });

  it("Windows 10: window share degrades to system audio, restrictOwnAudio strips the echo", () => {
    // Chromium reports identical settings for this case and the Windows 11
    // case above - there is no JS-visible signal that distinguishes genuine
    // per-app loopback from a system-audio fallback that got filtered
    // clean. Both are echo-free, so both get the same, correct verdict.
    const verdict = classifyShareAudio(video("window"), audio(true));
    expect(verdict.kind).toBe("application-scoped");
    expect(verdict.reason).toContain("indistinguishable");
  });

  it("macOS 14.2+ + Chrome 150+: window share with genuine per-application audio", () => {
    const verdict = classifyShareAudio(video("window"), audio(true));
    expect(verdict.kind).toBe("application-scoped");
  });

  it("Linux: getSupportedConstraints() claims restrictOwnAudio, but the live track never confirms it", () => {
    // audio(undefined) models getSettings().restrictOwnAudio coming back
    // absent - the platform cannot honour the constraint, so it never
    // reports the setting, no matter what getSupportedConstraints() said
    // before the picker opened.
    const verdict = classifyShareAudio(video("window"), audio(undefined));
    expect(verdict.kind).toBe("echo-risk");
  });

  it("monitor share with own audio not stripped: echo risk", () => {
    const verdict = classifyShareAudio(video("monitor"), audio(false));
    expect(verdict.kind).toBe("echo-risk");
    expect(verdict.message).toMatch(/not sent/);
  });

  it("monitor share with own audio confirmed stripped: system audio, safe", () => {
    const verdict = classifyShareAudio(video("monitor"), audio(true));
    expect(verdict.kind).toBe("system-audio-own-audio-stripped");
  });

  it("no audio track at all", () => {
    const verdict = classifyShareAudio(video("monitor"), null);
    expect(verdict.kind).toBe("no-audio");
  });

  it("tab surface is always safe, even without restrictOwnAudio: our own tab is excluded from the picker", () => {
    const verdict = classifyShareAudio(video("browser"), audio(false));
    expect(verdict.kind).toBe("application-scoped");
  });

  it("fails closed on an unrecognised surface even when restriction is confirmed", () => {
    const verdict = classifyShareAudio(video(undefined), audio(true));
    expect(verdict.kind).toBe("echo-risk");
  });
});
