import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The remembered profile is the one thing /qc keeps on purpose, so it is the
 * one thing worth pinning: it must survive a quota failure with the name
 * intact, and must never come back as a half-record that puts an empty name
 * in front of strangers.
 */

const store = new Map<string, string>();
let quota = Infinity;

const fakeLocalStorage = {
  getItem: (k: string) => store.get(k) ?? null,
  setItem: (k: string, v: string) => {
    if (v.length > quota) throw new Error("QuotaExceededError");
    store.set(k, v);
  },
  removeItem: (k: string) => void store.delete(k),
};

let quickStorageOn = true;

vi.mock("$lib/identity/identity.svelte", () => ({
  createEphemeral: vi.fn(async () => {}),
}));
vi.mock("$lib/profile.svelte", () => ({
  saveName: vi.fn(async () => {}),
  saveAvatar: vi.fn(async () => {}),
}));
vi.mock("$lib/transport/transport.svelte", () => ({
  joinRoom: vi.fn(async () => true),
  leaveRoom: vi.fn(),
  useEphemeralSession: vi.fn(),
}));
vi.mock("$lib/transport/call.svelte", () => ({
  joinCall: vi.fn(async () => {}),
  leaveCall: vi.fn(),
}));
vi.mock("./quick-storage", () => ({
  isQuickStorage: () => quickStorageOn,
  dropQuickStorage: async () => {},
}));

async function load() {
  vi.resetModules();
  vi.stubGlobal("localStorage", fakeLocalStorage);
  return import("./quick-call.svelte");
}

describe("quick call profile", () => {
  beforeEach(() => {
    store.clear();
    quota = Infinity;
    quickStorageOn = true;
    vi.unstubAllGlobals();
  });

  it("calls as a guest when nothing was remembered", async () => {
    const m = await load();
    expect(m.quickCall.remembered).toBe(false);
    expect(m.quickCall.profile.name).toMatch(/^Guest \d{4}$/);
  });

  it("comes back with the name and picture from last time", async () => {
    vi.stubGlobal("localStorage", fakeLocalStorage);
    const m1 = await load();
    m1.rememberQuickProfile({ name: "Ada", avatarUrl: "data:image/png;base64,x" });

    const m2 = await load();
    expect(m2.quickCall.remembered).toBe(true);
    expect(m2.quickCall.profile).toEqual({
      name: "Ada",
      avatarUrl: "data:image/png;base64,x",
    });
  });

  it("keeps the name when the picture will not fit", async () => {
    const m = await load();
    quota = 40;
    m.rememberQuickProfile({ name: "Ada", avatarUrl: "x".repeat(500) });
    expect(m.readRememberedProfile()).toEqual({ name: "Ada" });
  });

  it("forgets on request", async () => {
    const m = await load();
    m.rememberQuickProfile({ name: "Ada" });
    m.rememberQuickProfile(null);
    expect(m.readRememberedProfile()).toBeNull();
  });

  it("ignores a record with no usable name", async () => {
    const m = await load();
    for (const raw of ['{"name":""}', '{"name":"  "}', "{}", "not json"]) {
      store.set("awful_qc_profile", raw);
      expect(m.readRememberedProfile(), raw).toBeNull();
    }
  });

  it("refuses to join when the throwaway scope was not set up", async () => {
    quickStorageOn = false;
    const m = await load();
    await m.prepareQuickCall();
    expect(m.quickCall.stage).toBe("failed");

    const transport = await import("$lib/transport/transport.svelte");
    await m.startQuickCall({ name: "Ada" });
    // Nothing may reach the real database, so nothing joins either.
    expect(transport.joinRoom).not.toHaveBeenCalled();
  });

  it("puts the profile in before joining, so the room sees it", async () => {
    const m = await load();
    const { saveName } = await import("$lib/profile.svelte");
    const { joinRoom } = await import("$lib/transport/transport.svelte");
    const { joinCall } = await import("$lib/transport/call.svelte");
    const order: string[] = [];
    vi.mocked(saveName).mockImplementation(async () => void order.push("name"));
    vi.mocked(joinRoom).mockImplementation(async () => {
      order.push("room");
      return true;
    });
    vi.mocked(joinCall).mockImplementation(async () => void order.push("call"));

    await m.prepareQuickCall();
    m.setQuickCallCode("ABCDEFGHJKMNP");
    await m.startQuickCall({ name: "Ada" });

    expect(m.quickCall.stage).toBe("in-call");
    expect(order).toEqual(["name", "name", "room", "call"]);
    expect(joinRoom).toHaveBeenCalledWith("ABCDEFGHJKMNP");
  });

  it("does not sit in 'joining' when the join fails", async () => {
    const m = await load();
    const { joinRoom } = await import("$lib/transport/transport.svelte");
    vi.mocked(joinRoom).mockRejectedValueOnce(new Error("relay is down"));
    await m.prepareQuickCall();
    await m.startQuickCall({ name: "Ada" });
    expect(m.quickCall.stage).toBe("failed");
    expect(m.quickCall.error).toBe("relay is down");
  });
});
