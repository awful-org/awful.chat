import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  getIceServers,
  refreshTurnCredentials,
  _resetIceServersForTest,
} from "./ice-server-list";

// The real endpoint returns username, credential, ttl (seconds) and urls, or
// a 204 when TURN_SECRET is unset (relay/turn.go).
function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => body,
  } as unknown as Response;
}

function noContentResponse(): Response {
  return {
    ok: true,
    status: 204,
    headers: { get: () => null },
    json: async () => {
      throw new Error("must not be parsed for a 204");
    },
  } as unknown as Response;
}

const credential = (ttl: number) => ({
  username: "1234567890:abcd",
  credential: "c29tZS1obWFj",
  ttl,
  urls: ["turn:relay.example.com:3478?transport=udp"],
});

describe("refreshTurnCredentials", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    _resetIceServersForTest();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  it("re-arms itself at half the ttl, so a day-old tab keeps a live credential", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(credential(7200))); // 2h, relay/turn.go's TTL
    vi.stubGlobal("fetch", fetchMock);

    await refreshTurnCredentials();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(
      getIceServers().some((s) => s.username === credential(7200).username)
    ).toBe(true);

    // Nothing happens before half the ttl (relay-audit.md finding 3: the
    // old code never refreshed at all, so this window used to run out).
    await vi.advanceTimersByTimeAsync(3599 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("clears the previous timer instead of stacking a second refresh chain", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse(credential(7200)));
    vi.stubGlobal("fetch", fetchMock);

    await refreshTurnCredentials();
    await refreshTurnCredentials(); // e.g. a second connect() in the same session
    expect(fetchMock).toHaveBeenCalledTimes(2);

    await vi.advanceTimersByTimeAsync(3600 * 1000);
    // One re-arm from the second call, not two: had the first call's timer
    // survived, this would be 4.
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("stays STUN-only and schedules nothing on a 204 (TURN_SECRET unset)", async () => {
    const fetchMock = vi.fn().mockResolvedValue(noContentResponse());
    vi.stubGlobal("fetch", fetchMock);

    await refreshTurnCredentials();
    expect(getIceServers()).toHaveLength(2); // STUN only

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1); // never re-armed
  });

  it("does not schedule a refresh when the response has no usable ttl", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({
        username: "1234567890:abcd",
        credential: "c29tZS1obWFj",
        urls: ["turn:relay.example.com:3478?transport=udp"],
        // ttl omitted
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await refreshTurnCredentials();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(24 * 60 * 60 * 1000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("swallows a network error and leaves the list STUN-only", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(refreshTurnCredentials()).resolves.toBeUndefined();
    expect(getIceServers()).toHaveLength(2);
  });
});
