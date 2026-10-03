import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomSecret } from "./room-security/keys";

const hosts: { secret: string; onStatus: (s: string) => void; cancel: ReturnType<typeof vi.fn> }[] = [];
let expiresIn = 300_000;
vi.mock("./invite-pairing", () => ({
  hostInvitationPairing: vi.fn(async (secret: string, onStatus: (s: string) => void) => {
    const cancel = vi.fn();
    hosts.push({ secret, onStatus, cancel });
    return { code: `c0${hosts.length}-abc`, expiresAt: Date.now() + expiresIn, cancel };
  }),
}));

const {
  cancelAllShortCodes, cancelShortCode, hostShortCode, liveShortCode, shortCodeLink, shortCodeOutcome,
} = await import("./short-codes.svelte");

const A = "r2_a" as RoomSecret;
const B = "r2_b" as RoomSecret;

describe("short codes", () => {
  beforeEach(() => {
    cancelAllShortCodes();
    hosts.length = 0;
    expiresIn = 300_000;
  });

  it("hosts once per room and hands the live code back again", async () => {
    const [first, again] = await Promise.all([hostShortCode(A), hostShortCode(A)]);
    expect(first).toEqual(again);
    expect(await hostShortCode(A)).toEqual(first);
    expect(hosts).toHaveLength(1);
    expect(liveShortCode(A)?.code).toBe(first.code);
    expect(liveShortCode(B)).toBeNull();
  });

  it("mints a fresh code when the live one is about to run out", async () => {
    expiresIn = 30_000;
    const old = await hostShortCode(A);
    expiresIn = 300_000;
    const fresh = await hostShortCode(A);
    expect(fresh.code).not.toBe(old.code);
    expect(hosts[0].cancel).toHaveBeenCalled();
    expect(liveShortCode(A)?.code).toBe(fresh.code);
  });

  it("drops a delivered code and keeps how it ended", async () => {
    await hostShortCode(A);
    hosts[0].onStatus("Invitation delivered. This code is now used.");
    expect(liveShortCode(A)).toBeNull();
    expect(shortCodeOutcome(A)).toBe("Invitation delivered. This code is now used.");
    await hostShortCode(A);
    expect(shortCodeOutcome(A)).toBeNull();
  });

  it("ignores the status of a code already replaced", async () => {
    expiresIn = 30_000;
    await hostShortCode(A);
    expiresIn = 300_000;
    const fresh = await hostShortCode(A);
    hosts[0].onStatus("Pairing stopped. Generate a new code.");
    expect(liveShortCode(A)?.code).toBe(fresh.code);
    expect(shortCodeOutcome(A)).toBeNull();
  });

  it("cancels one room, or every room on a lock", async () => {
    await hostShortCode(A);
    await hostShortCode(B);
    cancelShortCode(A);
    expect(hosts[0].cancel).toHaveBeenCalled();
    expect(liveShortCode(A)).toBeNull();
    expect(liveShortCode(B)).not.toBeNull();
    cancelAllShortCodes();
    expect(hosts[1].cancel).toHaveBeenCalled();
    expect(liveShortCode(B)).toBeNull();
  });

  it("links to the code in the fragment", () => {
    vi.stubGlobal("window", { location: { origin: "https://awful.chat" } });
    expect(shortCodeLink("k5t-8r5")).toBe("https://awful.chat/r/#k5t-8r5");
    vi.unstubAllGlobals();
  });
});
