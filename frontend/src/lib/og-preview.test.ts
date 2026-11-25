import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchOgPreview, playableVideo, retryAfterMs, type OgPreview } from "./og-preview";

const preview: OgPreview = { url: "https://a.b/", title: "A", mediaType: "none" };

function answer(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("retryAfterMs", () => {
  it("reads whole seconds", () => {
    expect(retryAfterMs("1")).toBe(1000);
    expect(retryAfterMs("61")).toBe(61000);
  });

  it("refuses what would ask again at once, forever", () => {
    for (const bad of [null, "", "0", "-1", "601", "1e3", "99999999999", "soon", "1.5"]) {
      expect(retryAfterMs(bad)).toBeNull();
    }
  });
});

describe("fetchOgPreview", () => {
  beforeEach(() => void vi.useFakeTimers());
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("asks again when the relay says to, and not before", async () => {
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(answer(429, { error: "rate limited" }, { "Retry-After": "42" }))
      .mockResolvedValueOnce(answer(429, { error: "rate limited" }, { "Retry-After": "7" }))
      .mockResolvedValueOnce(answer(200, preview));
    vi.stubGlobal("fetch", fetch);
    const onWait = vi.fn();
    const got = fetchOgPreview("https://a.b/?x=1&y", new AbortController().signal, onWait);
    await vi.advanceTimersByTimeAsync(41_999);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(onWait).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(fetch).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(await got).toEqual(preview);
    expect(fetch.mock.calls[0][0]).toContain("url=https%3A%2F%2Fa.b%2F%3Fx%3D1%26y");
  });

  it("gives up in the end", async () => {
    const fetch = vi.fn().mockImplementation(async () => answer(429, {}, { "Retry-After": "1" }));
    vi.stubGlobal("fetch", fetch);
    const got = fetchOgPreview("https://a.b/", new AbortController().signal, () => {});
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await got).toEqual({ url: "https://a.b/", mediaType: "none" });
    expect(fetch).toHaveBeenCalledTimes(6);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("stops waiting when the message goes away", async () => {
    const fetch = vi.fn().mockResolvedValue(answer(429, {}, { "Retry-After": "5" }));
    vi.stubGlobal("fetch", fetch);
    const ctrl = new AbortController();
    const got = fetchOgPreview("https://a.b/", ctrl.signal, () => {});
    const failed = expect(got).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(1_000);
    ctrl.abort();
    await failed;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("takes no error body for a preview, nor waits on a 429 that names no time", async () => {
    for (const r of [answer(502, { error: "All OG sources failed" }), answer(429, { error: "rate limited" })]) {
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(r));
      const onWait = vi.fn();
      expect(await fetchOgPreview("https://a.b/", new AbortController().signal, onWait)).toEqual({
        url: "https://a.b/",
        mediaType: "none",
      });
      expect(onWait).not.toHaveBeenCalled();
    }
  });

  it("rejects when the relay cannot be reached", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("offline")));
    await expect(fetchOgPreview("https://a.b/", new AbortController().signal, () => {})).rejects.toThrow("offline");
  });
});

describe("playableVideo", () => {
  const video = (videoContentType?: string): OgPreview => ({
    url: "https://a.b/",
    mediaType: "video",
    video: "https://a.b/v",
    videoContentType,
  });

  it("takes a video file, and one that does not say what it is", () => {
    expect(playableVideo(video("video/mp4"))).toBe("https://a.b/v");
    expect(playableVideo(video("Video/MP4; codecs=avc1"))).toBe("https://a.b/v");
    expect(playableVideo(video())).toBe("https://a.b/v");
  });

  it("takes what this browser says it plays", () => {
    const hls = video("application/vnd.apple.mpegurl");
    expect(playableVideo(hls, () => true)).toBe("https://a.b/v");
    expect(playableVideo(hls, () => false)).toBeNull();
  });

  it("refuses an embed page, which a video element cannot play", () => {
    expect(playableVideo(video("text/html"))).toBeNull();
    expect(playableVideo(video("application/x-shockwave-flash"))).toBeNull();
    expect(playableVideo({ ...video("video/mp4"), mediaType: "image" })).toBeNull();
    expect(playableVideo({ ...video("video/mp4"), video: undefined })).toBeNull();
  });
});
