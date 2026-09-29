import { beforeEach, describe, expect, it, vi } from "vitest";
import { deriveRoomKeys, newRoomSecret } from "$lib/room-security/keys";
const SECRET = newRoomSecret();
const ROOM = deriveRoomKeys(SECRET).discoveryId;
const callState = { inCall: false, callRoomCode: null as string | null, roomCode: null as string | null, error: null as string | null };

/**
 * The remembered profile is the one thing /qc keeps on purpose, so it is the
 * one thing worth pinning: it must survive a quota failure with the name
 * intact, and must never come back as a half-record that puts an empty name
 * in front of strangers.
 */

const store = new Map<string, string>();
const tabStore = new Map<string, string>();
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
vi.mock("$lib/identity/identity", async (importOriginal) => ({
  ...await importOriginal<typeof import("$lib/identity/identity")>(),
  requireSession: () => identityStore,
}));
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
  getRoom: vi.fn(async () => undefined),
  putRoom: vi.fn(async () => {}),
  closeDatabase: vi.fn(),
  clearAtRestFlagForCurrentOwner: vi.fn(),
  getOwnProfile: vi.fn(async () => ownProfile),
  putOwnProfile: vi.fn(async () => {}),
}));
vi.mock("$lib/transport/transport.svelte", () => ({
  joinRoom: vi.fn(async (room: string) => { callState.roomCode = room; return true; }),
  transportState: callState,
  leaveRoom: vi.fn(),
  useEphemeralSession: vi.fn(),
}));
vi.mock("./quick-storage", () => ({
  useQuickStorage: vi.fn(() => "awful-quick-test"),
  dropQuickStorage: vi.fn(async () => {}),
  dbName: () => "awful-quick-test",
}));
vi.mock("$lib/transport/call.svelte", () => ({
  joinCall: vi.fn(async () => { callState.inCall = true; callState.callRoomCode = callState.roomCode; }),
  leaveCall: vi.fn(),
}));

/** Per-tab, so a reload keeps it and a closed tab does not. */
const fakeSessionStorage = {
  getItem: (k: string) => tabStore.get(k) ?? null,
  setItem: (k: string, v: string) => void tabStore.set(k, v),
  removeItem: (k: string) => void tabStore.delete(k),
};

async function load() {
  vi.resetModules();
  vi.stubGlobal("localStorage", fakeLocalStorage);
  vi.stubGlobal("sessionStorage", fakeSessionStorage);
  const m = await import("./quick-call.svelte");
  m.setQuickCallCode(SECRET);
  return m;
}

describe("quick call profile", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    store.clear();
    tabStore.clear();
    quota = Infinity;
    identityStore.keypair = null;
    ownProfile = undefined;
    Object.assign(callState, { inCall: false, callRoomCode: null, roomCode: null, error: null });
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
    await vi.waitFor(() => expect(clearAtRestFlagForCurrentOwner).toHaveBeenCalled());
  });

  it("hanging up takes the call's database with it", async () => {
    const m = await load();
    const { closeDatabase } = await import("$lib/storage");
    const { dropQuickStorage } = await import("./quick-storage");
    const { leaveRoom } = await import("$lib/transport/transport.svelte");
    const order: string[] = [];
    vi.mocked(closeDatabase).mockImplementation(() => void order.push("close"));
    vi.mocked(dropQuickStorage).mockImplementation(async () => {
      order.push("drop");
    });
    vi.mocked(leaveRoom).mockImplementation(() => void order.push("leave"));

    await m.prepareAsGuest();
    m.setQuickCallCode(SECRET);
    await m.startQuickCall({ name: "Ada" });
    order.length = 0; // the guest setup closed the real database on its way in
    m.endQuickCall();

    // The wire first, then the bytes - and the connection has to be closed
    // before the delete or it queues behind it.
    await vi.waitFor(() => expect(order).toEqual(["leave", "leave", "close", "drop"]));
    expect(m.quickCall.stage).toBe("ended");
  });

  it("a call that was ended is never resumed", async () => {
    const m = await load();
    await m.prepareAsGuest();
    m.setQuickCallCode(SECRET);
    await m.startQuickCall({ name: "Ada" });
    expect(m.resumableSession(SECRET)).not.toBeNull();

    m.endQuickCall();
    expect(m.resumableSession(SECRET)).toBeNull();
  });

  it("a refresh before anyone was chosen is not a call to resume", async () => {
    const m = await load();
    // Opening the page saves the code and who minted it, nothing more.
    m.setQuickCallCode(undefined, true);
    const code = m.quickCall.code;
    // Resuming this used to pick "guest" for someone still deciding.
    expect(m.resumableSession(code)).toBeNull();
    expect(m.hostedHere(code)).toBe(true);
    expect(m.hostedHere("7QK3M9AB2C")).toBeNull();

    await m.prepareAsGuest();
    expect(m.resumableSession(code)?.identity).toBe("guest");
  });

  it("backs out of the account unlock to the choice", async () => {
    const m = await load();
    m.chooseAccount();
    expect(m.quickCall.stage).toBe("unlocking");
    m.backToChoosing();
    expect(m.quickCall.stage).toBe("choosing");
    expect(m.quickCall.identity).toBe("guest");
  });

  it("starting another call mints a new code and hosts it", async () => {
    const m = await load();
    await m.prepareAsGuest();
    m.setQuickCallCode(SECRET);
    await m.startQuickCall({ name: "Ada" });
    m.endQuickCall();

    const next = m.startAnotherCall();
    expect(next).toMatch(/^r2_[a-z2-7]{52}$/);
    expect(next).not.toBe(SECRET);
    expect(m.quickCall.stage).toBe("setup");
    await m.startQuickCall({ name: "Ada" });
    expect(m.resumableSession(next)).toMatchObject({ identity: "guest", inCall: true, code: next });
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

  it("stores the capability only in disposable storage and joins by public ID", async () => {
    const m = await load(); await m.prepareAsGuest(); await m.startQuickCall({ name: "Ada" });
    const { putRoom } = await import("$lib/storage");
    const { joinRoom } = await import("$lib/transport/transport.svelte");
    expect(putRoom).toHaveBeenCalledWith(expect.objectContaining({ roomCode: ROOM, roomSecret: SECRET }), expect.any(Function));
    expect(joinRoom).toHaveBeenCalledWith(ROOM); expect(m.quickCall.roomCode).toBe(ROOM);
    expect(m.quickCall.stage).toBe("in-call");
  });

  it.each(["7QK3M9AB2C", ROOM, "bad"])("rejects invalid launch %s before storage/identity preparation", async code => {
    const m = await load(); expect(m.setQuickCallCode(code)).toBe("");
    await m.prepareAsGuest(); await m.adoptAccount();
    const { useQuickStorage } = await import("./quick-storage");
    expect(useQuickStorage).not.toHaveBeenCalled(); expect(m.quickCall.stage).toBe("failed");
  });

  it("does not report success when core call join fails or lands in another room", async () => {
    const m = await load(); await m.prepareAsGuest();
    const { joinCall } = await import("$lib/transport/call.svelte");
    vi.mocked(joinCall).mockImplementationOnce(async () => { callState.inCall = true; callState.callRoomCode = "wrong"; });
    await m.startQuickCall({ name: "Ada" }); expect(m.quickCall.stage).toBe("failed");
    expect(m.resumableSession(SECRET)?.inCall).not.toBe(true);
  });

  it("rejects a stored capability substituted under this room ID", async () => {
    const m = await load(); await m.prepareAsGuest();
    const { getRoom } = await import("$lib/storage");
    vi.mocked(getRoom).mockResolvedValueOnce({ roomCode: ROOM, roomSecret: newRoomSecret() } as never);
    await m.startQuickCall({ name: "Ada" }); expect(m.quickCall.stage).toBe("failed");
    const { joinRoom } = await import("$lib/transport/transport.svelte"); expect(joinRoom).not.toHaveBeenCalled();
  });

  it("hangup during a pending room join prevents late media entry and resume", async () => {
    const m = await load(); await m.prepareAsGuest();
    const { joinRoom } = await import("$lib/transport/transport.svelte");
    const { joinCall } = await import("$lib/transport/call.svelte");
    let finish!: (v: boolean) => void;
    vi.mocked(joinRoom).mockImplementationOnce(() => new Promise(r => { finish = r; }));
    const pending = m.startQuickCall({ name: "Ada" }); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    m.endQuickCall(); finish(true); await pending;
    expect(joinCall).not.toHaveBeenCalled(); expect(m.quickCall.stage).toBe("ended"); expect(m.resumableSession(SECRET)).toBeNull();
  });

  it("serializes replacement behind cancelled identity preparation and cleanup", async () => {
    const m = await load(); const { createEphemeral } = await import("$lib/identity/identity.svelte");
    let finish!: () => void;
    vi.mocked(createEphemeral).mockImplementationOnce(() => new Promise(r => { finish = r; }));
    const pending = m.prepareAsGuest(); await vi.waitFor(() => expect(finish).toBeTypeOf("function"));
    m.endQuickCall(); m.startAnotherCall(); const replacement = m.prepareAsGuest(); finish(); await pending; await replacement;
    expect(m.quickCall.stage).toBe("setup"); expect(createEphemeral).toHaveBeenCalledTimes(2);
    expect(m.resumableSession(SECRET)).toBeNull();
  });
});
