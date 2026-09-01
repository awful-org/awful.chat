import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  UPLOAD_MAX_CHARS,
  collectorAvailable,
  hexSha256,
  resetUploadStateForTest,
  signedContent,
  uploadBundle,
} from "./upload";
import { buildClientBundle } from "./bundle";
import { setDiagUpload } from "./prefs.svelte";
import {
  beginSession,
  initRecorder,
  rec,
  recorderSnapshot,
  resetRecorderForTest,
} from "./recorder";
import { ev } from "./event";
import { setRuntimeConfig } from "../runtime-config";
import type { ClientBundle } from "./schema";

const CTX = {
  version: "1.0.0",
  commit: "deadbee",
  ua: "test",
  now: 1_750_000_000_000,
  randomHex: (bytes: number) => "a".repeat(bytes * 2),
};

function bundle(): ClientBundle {
  resetRecorderForTest();
  initRecorder({
    selfPeerId: () => "12D3KooWSELF",
    runtime: () => ({
      apiHost: "relay.example.org",
      relayPeerId: "12D3KooWRELAY",
      sfuHosts: [],
      configured: true,
    }),
    faultsActive: () => false,
  });
  beginSession("sess", 1_749_999_000_000);
  rec(ev("session.start"));
  return buildClientBundle(recorderSnapshot(), CTX);
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  resetUploadStateForTest();
  setDiagUpload(true);
  setRuntimeConfig({ apiUrl: "https://relay.example.org" });
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  // `btoa` exists in node 25, but the module must not depend on that.
  if (typeof globalThis.btoa !== "function") {
    vi.stubGlobal("btoa", (s: string) =>
      Buffer.from(s, "binary").toString("base64")
    );
  }
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function reply(status: number, body: unknown = {}): Response {
  return {
    status,
    ok: status >= 200 && status < 300,
    json: async () => body,
  } as unknown as Response;
}

describe("signedContent", () => {
  it("is exactly the documented string", () => {
    // The relay's `verifyTelemetryAuth` builds the same string. A drift here is
    // a silent 401 on every upload, so the literal is pinned on both sides.
    expect(signedContent(1750000000000, "abc123")).toBe(
      "awful-telemetry:1750000000000:abc123"
    );
  });

  it("uses a prefix that is not the mailbox prefix", () => {
    // Domain separation: a shared prefix would make one signature valid on
    // both surfaces.
    expect(signedContent(1, "x")).not.toContain("awful-mailbox:");
  });
});

describe("hexSha256", () => {
  it("hashes the body to lowercase hex", () => {
    expect(hexSha256("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
  });
});

describe("uploadBundle", () => {
  it("refuses before any fetch when the switch is off", async () => {
    setDiagUpload(false);
    expect(await uploadBundle(bundle())).toEqual({ ok: false, reason: "off" });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("refuses when this build knows no relay", async () => {
    setRuntimeConfig({ apiUrl: "" });
    expect(await uploadBundle(bundle())).toEqual({
      ok: false,
      reason: "disabled",
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("posts to the relay the app already knows, with no new config key", async () => {
    fetchMock.mockResolvedValue(reply(200, { bundleId: "b1" }));
    expect(await uploadBundle(bundle())).toEqual({ ok: true, bundleId: "b1" });
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://relay.example.org/telemetry");
    expect(init.method).toBe("POST");
  });

  it("signs the body it actually sends", async () => {
    fetchMock.mockResolvedValue(reply(200, { bundleId: "b1" }));
    await uploadBundle(bundle());
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    const headers = init.headers as Record<string, string>;
    expect(headers["x-awful-peer"]).toBe("12D3KooWSELF");
    expect(Number(headers["x-awful-ts"])).toBeGreaterThan(0);
    expect(headers["x-awful-sig"]).toMatch(/^[A-Za-z0-9+/=]+$/);
    // The relay hashes the bytes it reads, so the hash must cover this body.
    expect(typeof init.body).toBe("string");
  });

  it("maps 204 to disabled and memoizes it", async () => {
    fetchMock.mockResolvedValue(reply(204));
    expect(await uploadBundle(bundle())).toEqual({
      ok: false,
      reason: "disabled",
    });
    // The Upload button hides from this, with no second request.
    expect(await collectorAvailable()).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("maps 401 to unauthorized", async () => {
    fetchMock.mockResolvedValue(reply(401));
    expect(await uploadBundle(bundle())).toEqual({
      ok: false,
      reason: "unauthorized",
    });
  });

  it("maps 429 to rate-limited", async () => {
    fetchMock.mockResolvedValue(reply(429));
    expect(await uploadBundle(bundle())).toEqual({
      ok: false,
      reason: "rate-limited",
    });
  });

  it("maps a thrown fetch to network", async () => {
    fetchMock.mockRejectedValue(new TypeError("offline"));
    expect(await uploadBundle(bundle())).toEqual({
      ok: false,
      reason: "network",
    });
  });

  it("maps a 200 with no bundleId to network", async () => {
    fetchMock.mockResolvedValue(reply(200, { nope: true }));
    expect(await uploadBundle(bundle())).toEqual({
      ok: false,
      reason: "network",
    });
  });

  it("trims a bundle to fit the collector's body limit", async () => {
    fetchMock.mockResolvedValue(reply(200, { bundleId: "b1" }));
    const big = bundle();
    big.events = Array.from({ length: 20_000 }, (_, i) => ({
      seq: i + 1,
      t: i,
      kind: "peer.rtt" as const,
      sev: "debug" as const,
      peer: "12D3KooWPEER",
      room: null,
      d: { pad: "x".repeat(180) },
    }));
    await uploadBundle(big);
    const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect((init.body as string).length).toBeLessThanOrEqual(UPLOAD_MAX_CHARS);
  });
});

describe("collectorAvailable", () => {
  it("treats any non-204 answer as a live route", async () => {
    fetchMock.mockResolvedValue(reply(400));
    expect(await collectorAvailable()).toBe(true);
  });

  it("does not memoize a network failure", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("offline"));
    expect(await collectorAvailable()).toBe(false);
    fetchMock.mockResolvedValue(reply(400));
    expect(await collectorAvailable()).toBe(true);
  });
});
