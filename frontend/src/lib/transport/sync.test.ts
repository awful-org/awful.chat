import { afterEach, describe, expect, it, vi } from "vitest";

// sync.svelte.ts pulls in LibP2PTransport, whose WebRTC dependency chain
// needs a native binding (node-datachannel) this test environment doesn't
// build. The fake below records handlers and sent frames, and lets a test
// script send() results (a queued `false` models a stream that never
// confirmed), which is enough to drive the target-side handshake.
const { FakeTransport, instances } = vi.hoisted(() => {
  const instances: any[] = [];
  class FakeTransport {
    handlers = new Map<string, ((...args: any[]) => void)[]>();
    sent: { type: string; payload?: any }[] = [];
    sendResults: boolean[] = [];
    constructor() {
      instances.push(this);
    }
    on(event: string, fn: (...args: any[]) => void) {
      const arr = this.handlers.get(event) ?? [];
      arr.push(fn);
      this.handlers.set(event, arr);
    }
    emit(event: string, ...args: any[]) {
      if (event === "message" && args.length === 2) args.push((this as any).pairingRoom);
      for (const fn of this.handlers.get(event) ?? []) fn(...args);
    }
    async connect() {}
    joinRoom() {}
    joinSecureRoom() {}
    async sendSecureRoom(peer: string, _room: string, data: Uint8Array) {
      return FakeTransport.prototype.send.call(this, peer, data);
    }
    async disconnect() {}
    selfId() {
      return "12D3KooW" + "A".repeat(44);
    }
    async send(_peerId: string, data: Uint8Array) {
      this.sent.push(JSON.parse(new TextDecoder().decode(data)));
      return this.sendResults.length ? this.sendResults.shift()! : true;
    }
  }
  return { FakeTransport, instances };
});
vi.mock("./libp2p/transport", () => ({ LibP2PTransport: FakeTransport }));
const { forgetSyncedRoom } = vi.hoisted(() => ({ forgetSyncedRoom: vi.fn() }));
vi.mock("./transport.svelte", () => ({ forgetSyncedRoom }));

// The import half is exercised in backup-restore.test.ts against a real
// database; here only WHAT the target hands it matters.
const { importCalls, importControl } = vi.hoisted(() => ({
  importCalls: [] as { data: any; mode: string; options: any }[],
  importControl: { run: null as null | ((options: any) => Promise<void>) },
}));
vi.mock("./backup-restore", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./backup-restore")>()),
  importDatabase: async (data: any, mode: any, options: any) => {
    importCalls.push({ data, mode, options });
    if (importControl.run) await importControl.run(options);
    else options.beforeCommit?.();
    return { droppedRecords: 0 };
  },
}));

import {
  cancelSync,
  connectAsTarget,
  generateShortCode,
  generateSyncCode,
  revealShortCode,
  matchesSourcePeer,
  parsePlaintextToken,
  parseShortCode,
  peerIdShortPrefix,
  syncState,
  tokenAccepted,
  utf8Length,
} from "./sync.svelte";
import { deriveRoomKeys, newRoomSecret } from "$lib/room-security/keys";
import * as storage from "$lib/storage";
import QRCode from "qrcode";
const SECURE_SECRET = newRoomSecret();
const SECURE_ROOM = deriveRoomKeys(SECURE_SECRET).discoveryId;

// A realistic-shaped Ed25519 libp2p peerId: the constant "12D3KooW" multihash
// prefix followed by base58 key material.
const PEER_ID = "12D3KooWBmoLnSw8ChzC2K1LZjb1XkUJDihMAcqBRfsTGjfCgHz";
const ROOM_CODE = "__sync_deadbeef";
const TOKEN = "0123456789abcdef0123456789abcdef";

describe("secure sync invitation and source authorization", () => {
  afterEach(async () => { await cancelSync(); });

  it("exports opened watermarks so backup and device restore cannot double-seal them", async () => {
    const { createIdentity, lockIdentity } = await import("$lib/identity/identity");
    await createIdentity("watermark-export-test-password");
    try {
      await storage.setWatermark(SECURE_ROOM, "watermark-export-sender", 73);
      const raw = await (await storage.getDB()).getAll("watermarks");
      expect(raw.some((row: any) => row._enc)).toBe(true);
      await generateSyncCode();
      const source = instances.at(-1);
      const payload = parsePlaintextToken(syncState.plaintextToken!)!;
      source.emit("message", "target", new TextEncoder().encode(JSON.stringify({
        type: "sync_export_request", payload: { token: payload.token, mode: "add" },
      })), payload.roomCode);
      await vi.waitFor(() => expect(source.sent.some((m: any) =>
        m.type === "sync_export_data" && JSON.stringify(m).includes("watermark-export-sender"),
      )).toBe(true));
      const frame = source.sent.find((m: any) =>
        m.type === "sync_export_data" && JSON.stringify(m).includes("watermark-export-sender"),
      );
      expect(JSON.stringify(frame)).not.toContain('"_enc"');
      expect(JSON.stringify(frame)).toContain('"maxLamport":73');
    } finally {
      await cancelSync();
      lockIdentity();
    }
  });

  it("applies target leaves before export and sends only own overrides with source markers", async () => {
    const { createIdentity, lockIdentity } = await import("$lib/identity/identity");
    await storage.wipeLocalDatabase();
    const { keypair } = await createIdentity("room-sync-test-password");
    const otherSecret = newRoomSecret();
    const otherCode = deriveRoomKeys(otherSecret).discoveryId;
    try {
      await storage.putRoom({ roomCode: SECURE_ROOM, roomSecret: SECURE_SECRET,
        type: "text", name: "Current", createdAt: 100, lastSeenLamport: 0, participants: [] });
      await storage.putOwnRoomProfile({ roomCode: SECURE_ROOM, did: keypair.did, generation: 100,
        fields: { nickname: "Room name", pfpData: new Uint8Array([1, 2]).buffer },
        fieldEdits: { nickname: { at: 101, id: "source" } } });
      await storage.putPeerRoomProfile(SECURE_ROOM, 100, { did: "did:peer", isMe: false,
        nickname: "Never sync peer cache", updatedAt: 102 });
      await storage.putRoom({ roomCode: otherCode, roomSecret: otherSecret,
        type: "text", name: "Left on target", createdAt: 200, lastSeenLamport: 0, participants: [] });
      await generateSyncCode();
      const source = instances.at(-1);
      const pairing = parsePlaintextToken(syncState.plaintextToken!)!;
      source.emit("message", "target", new TextEncoder().encode(JSON.stringify({
        type: "sync_export_request", payload: { token: pairing.token, mode: "add",
          roomDeletions: [{ roomCode: otherCode, generation: 100, deletedAt: 300 }] },
      })), pairing.roomCode);
      await vi.waitFor(() => expect(source.sent.some((m: any) => m.type === "sync_export_complete")).toBe(true));
      expect(await storage.getRoom(otherCode)).toBeUndefined();
      expect(forgetSyncedRoom).toHaveBeenCalledWith(otherCode);
      const sections = source.sent.filter((m: any) => m.type === "sync_export_data");
      const overrides = sections.filter((m: any) => m.payload.section === "roomProfiles")
        .flatMap((m: any) => m.payload.data);
      expect(overrides).toEqual([{ roomCode: SECURE_ROOM, did: keypair.did, generation: 100,
        fields: { nickname: "Room name", pfpData: btoa(String.fromCharCode(1, 2)) },
        fieldEdits: { nickname: { at: 101, id: "source" } } }]);
      expect(JSON.stringify(sections)).not.toContain("Never sync peer cache");
      const deletions = sections.filter((m: any) => m.payload.section === "roomDeletions")
        .flatMap((m: any) => m.payload.data);
      expect(deletions).toContainEqual({ roomCode: otherCode, generation: 100, deletedAt: 300 });
    } finally {
      await cancelSync(); lockIdentity();
    }
  });

  it("does not apply target markers without the full pairing token", async () => {
    await storage.wipeLocalDatabase();
    await (await import("../storage-crypto")).initStorageCrypto(new Uint8Array(32).fill(32));
    const secret = newRoomSecret();
    const code = deriveRoomKeys(secret).discoveryId;
    await storage.putRoom({ roomCode: code, roomSecret: secret, type: "text",
      name: "Keep", createdAt: 100, lastSeenLamport: 0, participants: [] });
    await generateSyncCode();
    const source = instances.at(-1);
    const pairing = parsePlaintextToken(syncState.plaintextToken!)!;
    source.emit("message", "target", new TextEncoder().encode(JSON.stringify({
      type: "sync_export_request", payload: { token: "bad-token", mode: "add",
        roomDeletions: [{ roomCode: code, generation: 100, deletedAt: 300 }] },
    })), pairing.roomCode);
    await vi.waitFor(() => expect(source.sent.some((m: any) => m.type === "sync_error")).toBe(true));
    expect((await storage.getRoom(code))?.createdAt).toBe(100);
    expect(forgetSyncedRoom).not.toHaveBeenCalledWith(code);
  });

  it("discards a pending QR result after a replacement session starts", async () => {
    let release!: (url: string) => void;
    const pending = new Promise<string>((resolve) => { release = resolve; });
    const spy = vi.spyOn(QRCode, "toDataURL").mockImplementationOnce(() => pending);
    try {
      const old = generateSyncCode();
      await vi.waitFor(() => expect(spy).toHaveBeenCalledTimes(1));
      await cancelSync();
      await generateSyncCode();
      const replacementCode = syncState.plaintextToken;
      const replacementQr = syncState.qrDataUrl;
      release("old-secret-qr");
      await old;
      expect(syncState.plaintextToken).toBe(replacementCode);
      expect(syncState.qrDataUrl).toBe(replacementQr);
      expect(syncState.syncError).toBeNull();
    } finally {
      release("discarded");
      spy.mockRestore();
    }
  });

  it("does not send a pending old export through a replacement sync session", async () => {
    await generateSyncCode();
    const old = instances.at(-1);
    const payload = parsePlaintextToken(syncState.plaintextToken!)!;
    const db = await storage.getDB();
    let release!: (value: typeof db) => void;
    const pending = new Promise<typeof db>((resolve) => { release = resolve; });
    const spy = vi.spyOn(storage, "getDB").mockImplementationOnce(() => pending);
    try {
      old.emit("message", "target", new TextEncoder().encode(JSON.stringify({
        type: "sync_export_request", payload: { token: payload.token, mode: "add" },
      })), payload.roomCode);
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      await cancelSync();
      await generateSyncCode();
      const replacement = instances.at(-1);
      const replacementCode = syncState.plaintextToken;
      release(db);
      // Give the actual IndexedDB export time to drain its transactions.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(replacement.sent).toHaveLength(0);
      expect(old.sent).toHaveLength(0);
      expect(syncState.plaintextToken).toBe(replacementCode);
      expect(syncState.syncError).toBeNull();
    } finally { release(db); spy.mockRestore(); }
  });

  it("old disconnect completion cannot reset replacement state", async () => {
    await generateSyncCode();
    const old = instances.at(-1);
    let release!: () => void;
    old.disconnect = () => new Promise<void>((resolve) => { release = resolve; });
    const cancelling = cancelSync();
    await generateSyncCode();
    const replacementCode = syncState.plaintextToken;
    expect(replacementCode).toBeTruthy();
    release();
    await cancelling;
    expect(syncState.plaintextToken).toBe(replacementCode);
  });

  it("rejects incomplete tokens and invalid expiry before constructing a transport", async () => {
    const before = instances.length;
    const payload = { roomSecret: SECURE_SECRET, roomCode: SECURE_ROOM, token: TOKEN,
      peerId: PEER_ID, expires: Date.now() + 60_000 };
    await expect(connectAsTarget({ ...payload, token: TOKEN.slice(0, 8) }))
      .rejects.toThrow("complete secure sync code");
    await expect(connectAsTarget({ ...payload, expires: NaN }))
      .rejects.toThrow("expiry");
    expect(instances).toHaveLength(before);
  });

  it("generates a copyable full-capability code and parses it without publishing the secret as the room ID", async () => {
    await generateSyncCode();
    expect(syncState.syncError).toBeNull();
    const payload = parsePlaintextToken(syncState.plaintextToken!);
    expect(payload?.roomSecret).toMatch(/^r2_/);
    expect(payload?.roomCode).toBe(instances.at(-1).pairingRoom);
    expect(payload?.roomCode).not.toContain(payload!.roomSecret!.slice(3));
    expect(payload?.token).toHaveLength(32);
    expect(payload?.peerId).toBe(instances.at(-1).selfId());
  });

  it("ignores raw export requests and refuses truncated tokens even when manual code is shown", async () => {
    await generateSyncCode();
    revealShortCode();
    const t = instances.at(-1);
    const payload = parsePlaintextToken(syncState.plaintextToken!)!;
    const frame = (token: string) => new TextEncoder().encode(JSON.stringify({
      type: "sync_export_request", payload: { token, mode: "replace" },
    }));
    t.emit("message", "intruder", frame(payload.token), null);
    await Promise.resolve();
    expect(t.sent).toHaveLength(0);
    t.emit("message", "intruder", frame(payload.token.slice(0, 8)), payload.roomCode);
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    expect(t.sent[0].type).toBe("sync_error");
    expect(syncState.isSyncing).toBe(false);
  });
});

describe("peerIdShortPrefix", () => {
  it("takes the 8 chars right after the Ed25519 prefix", () => {
    expect(peerIdShortPrefix(PEER_ID)).toBe(PEER_ID.slice(8, 16));
    expect(peerIdShortPrefix(PEER_ID)).toBe("BmoLnSw8");
  });

  it("still returns chars [8,16) for a peerId without the expected prefix", () => {
    const oddPeerId = "notEd25519PrefixedPeerIdString";
    expect(peerIdShortPrefix(oddPeerId)).toBe(oddPeerId.slice(8, 16));
  });
});

describe("generateShortCode / parseShortCode round trip", () => {
  it("round-trips room, token and peer prefix through the 3-part short code", () => {
    const code = generateShortCode(ROOM_CODE, TOKEN, PEER_ID);
    expect(code.split("-")).toHaveLength(3);

    const parsed = parseShortCode(code);
    expect(parsed).toEqual({
      roomCode: ROOM_CODE,
      token: TOKEN.slice(0, 8),
      peerPrefix: peerIdShortPrefix(PEER_ID).toLowerCase(),
    });
  });

  // A phone keyboard capitalised the code as it was typed, and the input
  // showed it in caps regardless, so the person could not even see the
  // difference. The peer segment is base58, which is case-sensitive, so an
  // exact compare rejected every code typed on a phone.
  it("accepts the code however a keyboard cased it", () => {
    const code = generateShortCode(ROOM_CODE, TOKEN, PEER_ID);
    const parsed = parseShortCode(code.toUpperCase());
    expect(parsed).toEqual(parseShortCode(code));
    expect(parsed?.roomCode).toBe(ROOM_CODE);
    expect(matchesSourcePeer(parsed as never, PEER_ID)).toBe(true);
  });

  it("rejects a 2-part (pre-peerId-pinning) short code", () => {
    expect(parseShortCode("deadbeef-01234567")).toBeNull();
  });

  it("rejects segments of the wrong length", () => {
    expect(parseShortCode("short-01234567-BmoLnSw8")).toBeNull();
  });
});

describe("parsePlaintextToken", () => {
  it("accepts a well-formed 3-part short code and carries the peerPrefix", () => {
    const code = generateShortCode(ROOM_CODE, TOKEN, PEER_ID);
    const payload = parsePlaintextToken(code);
    expect(payload).not.toBeNull();
    expect(payload!.roomCode).toBe(ROOM_CODE);
    expect(payload!.token).toBe(TOKEN.slice(0, 8));
    expect(payload!.peerPrefix).toBe(peerIdShortPrefix(PEER_ID).toLowerCase());
    expect(payload!.peerId).toBeUndefined();
  });

  it("rejects the old 2-part short code with a clear update-both-devices error", () => {
    expect(() => parsePlaintextToken("deadbeef-01234567")).toThrow(
      /update both devices/i
    );
  });

  it("accepts the 3-part full (colon-delimited) format with a peerId", () => {
    const payload = parsePlaintextToken(`${ROOM_CODE}:${TOKEN}:${PEER_ID}`);
    expect(payload).not.toBeNull();
    expect(payload!.roomCode).toBe(ROOM_CODE);
    expect(payload!.token).toBe(TOKEN);
    expect(payload!.peerId).toBe(PEER_ID);
    expect(payload!.peerPrefix).toBeUndefined();
  });

  it("rejects the old 2-part full format (room:token, no peerId)", () => {
    expect(() => parsePlaintextToken(`${ROOM_CODE}:${TOKEN}`)).toThrow(
      /update both devices/i
    );
  });

  it("returns null for garbage input", () => {
    expect(parsePlaintextToken("not a sync code")).toBeNull();
    expect(parsePlaintextToken("")).toBeNull();
  });
});

describe("the QR text", () => {
  // What the source draws into the QR is the "full format" the manual
  // parser reads, so a scan and a paste go through one parser and the
  // scan carries the whole peerId to pin to.
  it("parses to a payload pinned to the full peerId", () => {
    const payload = parsePlaintextToken(`${ROOM_CODE}:${TOKEN}:${PEER_ID}`);
    expect(payload).toMatchObject({
      roomCode: ROOM_CODE,
      token: TOKEN,
      peerId: PEER_ID,
    });
    expect(matchesSourcePeer(payload!, PEER_ID)).toBe(true);
  });
});

describe("matchesSourcePeer", () => {
  it("matches on the full peerId when the payload carries one", () => {
    expect(matchesSourcePeer({ peerId: PEER_ID } as never, PEER_ID)).toBe(
      true
    );
    expect(
      matchesSourcePeer({ peerId: PEER_ID } as never, "someOtherPeerId12345")
    ).toBe(false);
  });

  it("matches on the peerPrefix when the payload only carries that", () => {
    const prefix = peerIdShortPrefix(PEER_ID);
    expect(matchesSourcePeer({ peerPrefix: prefix } as never, PEER_ID)).toBe(
      true
    );
    expect(
      matchesSourcePeer({ peerPrefix: "ZZZZZZZZ" } as never, PEER_ID)
    ).toBe(false);
  });

  it("refuses to match anything when the payload has neither", () => {
    expect(matchesSourcePeer({} as never, PEER_ID)).toBe(false);
  });
});

describe("utf8Length", () => {
  // Batches are sized against the transport's 4MB frame cap, and an
  // oversized frame is not a polite failure: the receiver aborts the whole
  // inbound stream and the rest of the transfer goes with it.
  const encoded = (v: string) => new TextEncoder().encode(v).length;

  it("matches TextEncoder for ASCII", () => {
    expect(utf8Length("hello")).toBe(encoded("hello"));
  });

  it("matches TextEncoder for accented text", () => {
    const v = "ação, café, jalapeño";
    expect(utf8Length(v)).toBe(encoded(v));
  });

  it("matches TextEncoder for CJK, where .length undercounts by three", () => {
    const v = "今日はいい天気ですね";
    expect(utf8Length(v)).toBe(encoded(v));
    expect(v.length).toBeLessThan(utf8Length(v));
  });

  it("counts an emoji surrogate pair as one four-byte character", () => {
    const v = "👋🏽 hi 🎉";
    expect(utf8Length(v)).toBe(encoded(v));
  });

  it("matches TextEncoder on a lone surrogate rather than swallowing what follows", () => {
    // Not valid UTF-16, but JSON.stringify of a corrupt record can produce
    // one. The character AFTER it must still be counted: a version that
    // assumed every high surrogate had a partner passed the ASCII case here
    // by coincidence and undercounted this one.
    for (const v of ["a\ud800b", "\ud800今", "\ud800", "\udc00x"]) {
      expect(utf8Length(v)).toBe(encoded(v));
    }
  });

  it("is zero for empty input", () => {
    expect(utf8Length("")).toBe(0);
  });
});

describe("target ExportRequest delivery", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await cancelSync();
  });

  const payload = () => ({
    roomCode: SECURE_ROOM,
    roomSecret: SECURE_SECRET,
    token: TOKEN,
    expires: Date.now() + 60_000,
    peerId: PEER_ID,
  });

  const requests = (t: any) =>
    t.sent.filter((m: any) => m.type === "sync_export_request");

  it("retries the ExportRequest when the first send never confirms", async () => {
    vi.useFakeTimers();
    await connectAsTarget(payload());
    const t = instances.at(-1);
    t.sendResults = [false, true];
    t.emit("connect", PEER_ID);
    await vi.advanceTimersByTimeAsync(2_100);
    expect(requests(t)).toHaveLength(2);
    expect(syncState.syncError).toBeNull();
  });

  it("errors out instead of stalling at 0% when every send fails", async () => {
    vi.useFakeTimers();
    await connectAsTarget(payload());
    const t = instances.at(-1);
    t.sendResults = [false, false, false];
    t.emit("connect", PEER_ID);
    await vi.advanceTimersByTimeAsync(7_000);
    expect(requests(t)).toHaveLength(3);
    expect(syncState.syncError).toMatch(/Could not send the sync request/);
    expect(syncState.isSyncing).toBe(false);
  });

  it("does not re-request on a reconnect while the first request stands", async () => {
    await connectAsTarget(payload());
    const t = instances.at(-1);
    t.emit("connect", PEER_ID);
    t.emit("connect", PEER_ID);
    await Promise.resolve();
    expect(requests(t)).toHaveLength(1);
  });

  it("includes local leave markers in the initial authenticated export request", async () => {
    await storage.wipeLocalDatabase();
    await (await import("../storage-crypto")).initStorageCrypto(new Uint8Array(32).fill(31));
    await storage.deleteRoomProfilesForRoom("room-left-here", 100, 300);
    await connectAsTarget({ ...payload(), mode: "add" });
    const t = instances.at(-1);
    t.emit("connect", PEER_ID);
    await vi.waitFor(() => expect(requests(t)).toHaveLength(1));
    expect(requests(t)[0].payload.roomDeletions).toContainEqual({
      roomCode: "room-left-here", generation: 100, deletedAt: 300,
    });
  });

  it("ignores completion outside the authenticated pairing room", async () => {
    await connectAsTarget(payload());
    const t = instances.at(-1);
    t.emit("connect", PEER_ID);
    t.emit("message", PEER_ID, new TextEncoder().encode(JSON.stringify({ type: "sync_export_complete" })), "wrong-room");
    await Promise.resolve();
    expect(syncState.isComplete).toBe(false);
    expect(importCalls).toHaveLength(0);
  });

  it("rejects a pairing secret attached to another room before connecting", async () => {
    const count = instances.length;
    await expect(connectAsTarget({ ...payload(), roomCode: ROOM_CODE })).rejects.toThrow("capability mismatch");
    expect(instances).toHaveLength(count);
  });
});

// The 8-char short code carries 32 bits of the 128-bit token, which is
// guessable inside the code's 5-minute life. That truncation is the price of
// a code somebody can type - it is not a price the QR path has to pay too.
describe("tokenAccepted", () => {
  const FULL = TOKEN;

  it("accepts the full token whichever form is in play", () => {
    expect(tokenAccepted(FULL, FULL, false)).toBe(true);
    expect(tokenAccepted(FULL, FULL, true)).toBe(true);
  });

  it("accepts the 8-char prefix only when the short code is in play", () => {
    expect(tokenAccepted(FULL.slice(0, 8), FULL, true)).toBe(true);
    expect(tokenAccepted(FULL.slice(0, 8), FULL, false)).toBe(false);
  });

  // The short-code target holds 8 chars while the source echoes all 32, so
  // the truncated side is not always the received one.
  it("accepts the source's full echo against a typed short code", () => {
    expect(tokenAccepted(FULL, FULL.slice(0, 8), true)).toBe(true);
    expect(tokenAccepted(FULL, FULL.slice(0, 8), false)).toBe(false);
  });

  it("rejects a wrong token, an empty one, and a longer near-miss", () => {
    expect(tokenAccepted("00000000", FULL, true)).toBe(false);
    expect(tokenAccepted("", FULL, true)).toBe(false);
    expect(tokenAccepted(FULL.slice(0, 16), FULL, true)).toBe(false);
    expect(tokenAccepted(FULL, null, true)).toBe(false);
  });
});

// "Merge" keeps this device's account. The source skips the identity section
// in add mode, but a source that sends one anyway used to have it written
// straight over the target's identity - a takeover, not a merge.
describe("target-side identity handling", () => {
  afterEach(async () => {
    importControl.run = null;
    importCalls.length = 0;
    await cancelSync();
  });

  const frame = (obj: unknown) =>
    new TextEncoder().encode(JSON.stringify(obj));

  const identitySection = {
    mnemonic: { salt: [1], iv: [2], encrypted: [3], iterations: 600_000 },
    keypair: { did: "did:key:zSomebodyElse", publicKey: [4] },
  };

  async function runTarget(mode: "add" | "replace") {
    await connectAsTarget({
      roomCode: SECURE_ROOM,
      roomSecret: SECURE_SECRET,
      token: TOKEN,
      expires: Date.now() + 60_000,
      peerId: PEER_ID,
      mode,
    });
    const t = instances.at(-1);
    t.emit("connect", PEER_ID);
    t.emit(
      "message",
      PEER_ID,
      frame({
        type: "sync_export_data",
        payload: { section: "identity", data: identitySection, token: TOKEN },
      })
    );
    await vi.waitFor(() => expect(t.sent.length).toBeGreaterThan(1));
    t.emit("message", PEER_ID, frame({ type: "sync_export_complete" }));
    await vi.waitFor(() => expect(importCalls).toHaveLength(1));
    return importCalls[0];
  }

  it("passes received own overrides and leave markers to the importer", async () => {
    await connectAsTarget({ roomCode: SECURE_ROOM, roomSecret: SECURE_SECRET,
      token: TOKEN, expires: Date.now() + 60_000, peerId: PEER_ID, mode: "add" });
    const t = instances.at(-1);
    t.emit("connect", PEER_ID);
    for (const [section, record] of [
      ["roomProfiles", { roomCode: "room-a", did: "did:alice", generation: 100,
        fields: { nickname: null }, fieldEdits: { nickname: { at: 120, id: "a", reset: true } } }],
      ["roomDeletions", { roomCode: "room-b", generation: 100, deletedAt: 300 }],
    ] as const) {
      t.emit("message", PEER_ID, frame({ type: "sync_export_data", payload: {
        section, data: [record], token: TOKEN, batchIndex: 0, totalBatches: 1,
      } }));
    }
    await vi.waitFor(() => expect(t.sent.filter((m: any) => m.type === "sync_export_ack")).toHaveLength(2));
    t.emit("message", PEER_ID, frame({ type: "sync_export_complete" }));
    await vi.waitFor(() => expect(importCalls).toHaveLength(1));
    expect(importCalls[0].data.roomProfiles).toEqual([{ roomCode: "room-a", did: "did:alice",
      generation: 100, fields: { nickname: null }, fieldEdits: { nickname: { at: 120, id: "a", reset: true } } }]);
    expect(importCalls[0].data.roomDeletions).toEqual([{ roomCode: "room-b", generation: 100, deletedAt: 300 }]);
  });

  it("drops the identity section in add mode", async () => {
    const call = await runTarget("add");
    expect(call.mode).toBe("add");
    expect(call.data.identity).toBeUndefined();
  });

  it("rejects an old target's commit after cancellation while its password was pending", async () => {
    let resume!: () => void;
    let rejected = false;
    const pending = new Promise<void>((resolve) => { resume = resolve; });
    importControl.run = async (options) => {
      await pending;
      try { options.beforeCommit(); }
      catch (error) { rejected = true; throw error; }
    };
    try {
      await runTarget("replace");
      await cancelSync();
      await generateSyncCode();
      const replacementCode = syncState.plaintextToken;
      resume();
      await vi.waitFor(() => expect(rejected).toBe(true));
      expect(syncState.plaintextToken).toBe(replacementCode);
      expect(syncState.syncError).toBeNull();
    } finally { resume(); }
  });

  it("waits for committed import writes before starting a replacement session", async () => {
    let finish!: () => void;
    const writes = new Promise<void>((resolve) => { finish = resolve; });
    importControl.run = async (options) => {
      options.beforeCommit();
      await writes;
    };
    try {
      await runTarget("replace");
      await cancelSync();
      const count = instances.length;
      const replacement = generateSyncCode();
      // Drain startup microtasks; the import write lease must still block it.
      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(instances).toHaveLength(count);
      expect(syncState.plaintextToken).toBeNull();
      finish();
      await replacement;
      expect(instances).toHaveLength(count + 1);
      expect(syncState.plaintextToken).not.toBeNull();
      expect(syncState.syncError).toBeNull();
    } finally { finish(); }
  });

  it("rejects obsolete short codes before creating a network session", async () => {
    const count = instances.length;
    await expect(connectAsTarget({
      roomCode: ROOM_CODE,
      // What parseShortCode produces: 8 chars of token, 8 of peerId.
      token: TOKEN.slice(0, 8),
      peerPrefix: PEER_ID.slice(8, 16),
      expires: Date.now() + 60_000,
      mode: "replace",
    })).rejects.toThrow("Update both devices");
    expect(instances).toHaveLength(count);
    expect(importCalls).toHaveLength(0);
  });

  it("still adopts it in replace mode, which is what replace means", async () => {
    const call = await runTarget("replace");
    expect(call.mode).toBe("replace");
    expect(call.data.identity.keypair.did).toBe("did:key:zSomebodyElse");
  });
});
