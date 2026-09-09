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

const identityStore = { keypair: null as unknown, did: "did:key:zSelf" };
let ownProfile: Record<string, unknown> | undefined;

vi.mock("$lib/identity/identity.svelte", () => ({
  createEphemeral: vi.fn(async () => {}),
  identityStore,
}));
vi.mock("$lib/profile.svelte", () => ({
  saveName: vi.fn(async () => {}),
  saveAvatar: vi.fn(async () => {}),
  loadProfile: vi.fn(async () => {}),
}));
vi.mock("$lib/storage", () => ({
  closeDatabase: vi.fn(),
  clearAtRestFlagForCurrentOwner: vi.fn(),
  getOwnProfile: vi.fn(async () => ownProfile),
  putOwnProfile: vi.fn(async () => {}),
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
  useQuickStorage: vi.fn(() => "awful-quick-test"),
  dropQuickStorage: vi.fn(async () => {}),
  dbName: () => "awful-quick-test",
}));

async function load() {
  vi.resetModules();
  vi.stubGlobal("localStorage", fakeLocalStorage);
  return import("./quick-call.svelte");
}

describe("quick call profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    quota = Infinity;
    identityStore.keypair = null;
    ownProfile = undefined;
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

  it("refuses to join before an identity exists", async () => {
    const m = await load();
    const { joinRoom } = await import("$lib/transport/transport.svelte");
    // Straight to Join without choosing who to be: nothing may reach the
    // network, and nothing may be written anywhere.
    await m.startQuickCall({ name: "Ada" });
    expect(m.quickCall.stage).toBe("failed");
    expect(joinRoom).not.toHaveBeenCalled();
  });

  it("moves off the real database before a guest writes anything", async () => {
    const m = await load();
    const { closeDatabase } = await import("$lib/storage");
    const { useQuickStorage } = await import("./quick-storage");
    const { createEphemeral } = await import("$lib/identity/identity.svelte");
    const { saveName } = await import("$lib/profile.svelte");
    const order: string[] = [];
    vi.mocked(closeDatabase).mockImplementation(() => void order.push("close"));
    vi.mocked(useQuickStorage).mockImplementation(() => {
      order.push("switch");
      return "awful-quick-test";
    });
    vi.mocked(createEphemeral).mockImplementation(
      async () => void order.push("identity")
    );
    vi.mocked(saveName).mockImplementation(async () => void order.push("name"));

    await m.prepareAsGuest();

    expect(order).toEqual(["close", "switch", "identity", "name"]);
    expect(m.quickCall.stage).toBe("setup");
    expect(m.quickCall.identity).toBe("guest");
  });

  it("carries the account's whole profile row into the call", async () => {
    identityStore.keypair = { did: "did:key:zSelf" };
    ownProfile = {
      did: "did:key:zSelf",
      isMe: true,
      nickname: "Ada",
      pfpData: new ArrayBuffer(8),
      color: "#ff0000",
    };
    const m = await load();
    const { putOwnProfile, closeDatabase } = await import("$lib/storage");
    const { useQuickStorage } = await import("./quick-storage");
    const { createEphemeral } = await import("$lib/identity/identity.svelte");

    expect(m.hasAccount()).toBe(true);
    m.chooseAccount();
    expect(m.quickCall.stage).toBe("unlocking");
    await m.adoptAccount();

    // The ROW, not the display store: an uploaded avatar is bytes, and a
    // blob: URL would mean nothing to the other side.
    expect(putOwnProfile).toHaveBeenCalledWith(
      expect.objectContaining({ nickname: "Ada", color: "#ff0000" })
    );
    // Read the real database first, then move off it.
    expect(closeDatabase).toHaveBeenCalled();
    expect(useQuickStorage).toHaveBeenCalled();
    // The account's session is already live: no second, ephemeral identity.
    expect(createEphemeral).not.toHaveBeenCalled();
    expect(m.quickCall.stage).toBe("setup");
    expect(m.quickCall.profile.name).toBe("Ada");
  });

  it("keeps an account's own at-rest marker on teardown", async () => {
    identityStore.keypair = { did: "did:key:zSelf" };
    ownProfile = { did: "did:key:zSelf", isMe: true, nickname: "Ada" };
    const m = await load();
    const { clearAtRestFlagForCurrentOwner } = await import("$lib/storage");
    m.chooseAccount();
    await m.adoptAccount();
    m.teardownQuickCall();
    // It belongs to the real database, which this page only read.
    expect(clearAtRestFlagForCurrentOwner).not.toHaveBeenCalled();
  });

  it("takes a guest's at-rest marker with it", async () => {
    const m = await load();
    const { clearAtRestFlagForCurrentOwner } = await import("$lib/storage");
    await m.prepareAsGuest();
    m.teardownQuickCall();
    expect(clearAtRestFlagForCurrentOwner).toHaveBeenCalled();
  });

  it("does not sit in 'joining' when the join fails", async () => {
    const m = await load();
    const { joinRoom } = await import("$lib/transport/transport.svelte");
    vi.mocked(joinRoom).mockRejectedValueOnce(new Error("relay is down"));
    await m.prepareAsGuest();
    await m.startQuickCall({ name: "Ada" });
    expect(m.quickCall.stage).toBe("failed");
    expect(m.quickCall.error).toBe("relay is down");
  });
});
