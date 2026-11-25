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
    sent: { type: string; v?: number; payload?: any }[] = [];
    /** Which peer each sent frame went to, index for index with `sent`. */
    sentTo: string[] = [];
    sendResults: boolean[] = [];
    /**
     * When set, every data frame this transport sends is acked back as if
     * by this peer - the export is paced on acks, and a test that is not
     * about pacing should not have to answer each frame by hand.
     */
    autoAck: string | null = null;
    /** A finished target is told it was heard. */
    autoDone = true;
    /** Channels left for a fresh one (SecureSyncTransport.reopen). */
    reopened: string[] = [];
    /** Frames from here on are taken by the link and come out nowhere. */
    blackhole = false;
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
    openConnections() {
      return [];
    }
    secureRoomConnection() {
      return null;
    }
    closeSecureRoom(peer: string) {
      this.reopened.push(peer);
      this.blackhole = false;
      return [];
    }
    selfId() {
      return "12D3KooW" + "A".repeat(44);
    }
    async send(peerId: string, data: Uint8Array) {
      const msg = JSON.parse(new TextDecoder().decode(data));
      this.sent.push(msg);
      this.sentTo.push(peerId);
      const ok = this.sendResults.length ? this.sendResults.shift()! : true;
      if (ok && this.autoDone && msg.type === "sync_export_complete" && !msg.payload) {
        queueMicrotask(() => this.emit("message", peerId, new TextEncoder().encode(
          JSON.stringify({ type: "sync_done", v: SYNC_PROTOCOL_VERSION }))));
      }
      if (ok && !this.blackhole && this.autoAck && msg.type === "sync_export_data") {
        const from = this.autoAck;
        queueMicrotask(() => this.emit("message", from, new TextEncoder().encode(JSON.stringify({
          type: "sync_export_ack", v: SYNC_PROTOCOL_VERSION, payload: { seq: msg.payload.seq },
        }))));
      }
      return ok;
    }
  }
  return { FakeTransport, instances };
});
vi.mock("./libp2p/transport", () => ({ LibP2PTransport: FakeTransport }));

// The import half is exercised in backup-restore.test.ts against a real
// database; here only WHAT the target hands it matters.
const { importCalls, importControl, markerControl } = vi.hoisted(() => ({
  importCalls: [] as { data: any; mode: string; options: any }[],
  importControl: { run: null as null | ((options: any) => Promise<void>) },
  markerControl: { fail: false },
}));
vi.mock("./backup-restore", async (importOriginal) => {
  const original = await importOriginal<typeof import("./backup-restore")>();
  return {
    ...original,
    importDatabase: async (data: any, mode: any, options: any) => {
      importCalls.push({ data, mode, options });
      if (importControl.run) await importControl.run(options);
      else options.beforeCommit?.();
      return { droppedRecords: 0 };
    },
    applyRoomDeletionMarkers: async (markers: unknown[]) => {
      if (markerControl.fail) throw new Error("storage went away");
      return original.applyRoomDeletionMarkers(markers);
    },
  };
});

import {
  approveSync,
  cancelSync,
  connectAsTarget,
  denySync,
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
import { EXPORT_SECTIONS } from "./backup";
import { DIFFERENT_ACCOUNT_MERGE } from "./backup-restore";
import { SYNC_PROTOCOL_VERSION, SYNC_VERSION_MISMATCH, syncComparisonCode } from "./sync-protocol";
import { signPeerBinding } from "$lib/messaging";
const SECURE_SECRET = newRoomSecret();
const SECURE_ROOM = deriveRoomKeys(SECURE_SECRET).discoveryId;

// A realistic-shaped Ed25519 libp2p peerId: the constant "12D3KooW" multihash
// prefix followed by base58 key material.
const PEER_ID = "12D3KooWBmoLnSw8ChzC2K1LZjb1XkUJDihMAcqBRfsTGjfCgHz";
const ROOM_CODE = "__sync_deadbeef";
const TOKEN = "0123456789abcdef0123456789abcdef";

const encodeFrame = (obj: unknown) => new TextEncoder().encode(JSON.stringify(obj));

/** A version-2 export request, as the target sends it. */
function exportRequest(token: string, mode: "add" | "replace", extra: Record<string, unknown> = {}) {
  return encodeFrame({ type: "sync_export_request", v: SYNC_PROTOCOL_VERSION, payload: { token, mode, ...extra } });
}

/** Source-side: wait for the request to be put to the user, then allow it. */
async function approveWhenAsked(source: any, requester = "target") {
  await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
  source.autoAck = requester;
  await approveSync();
}

/** A manifest listing every section, empty unless `counts` says otherwise. */
function manifest(counts: Record<string, { items: number; batches: number }> = {}) {
  return Object.fromEntries([
    ...EXPORT_SECTIONS.map((name) => [name, { items: 0, batches: 0 }]),
    ...Object.entries(counts),
  ]);
}

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
      source.emit("message", "target", exportRequest(payload.token, "add"), payload.roomCode);
      await approveWhenAsked(source);
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
      source.emit("message", "target", exportRequest(pairing.token, "add", {
        roomDeletions: [{ roomCode: otherCode, generation: 100, deletedAt: 300 }],
      }), pairing.roomCode);
      await approveWhenAsked(source);
      await vi.waitFor(() => expect(source.sent.some((m: any) => m.type === "sync_export_complete")).toBe(true));
      // A leave on the other device governs room profiles only: this device
      // still holds the room in the generation the marker names, so it keeps
      // it, its history, and does not adopt the marker.
      expect((await storage.getRoom(otherCode))?.createdAt).toBe(200);
      const sections = source.sent.filter((m: any) => m.type === "sync_export_data");
      const overrides = sections.filter((m: any) => m.payload.section === "roomProfiles")
        .flatMap((m: any) => m.payload.data);
      expect(overrides).toEqual([{ roomCode: SECURE_ROOM, did: keypair.did, generation: 100,
        fields: { nickname: "Room name", pfpData: btoa(String.fromCharCode(1, 2)) },
        fieldEdits: { nickname: { at: 101, id: "source" } } }]);
      expect(JSON.stringify(sections)).not.toContain("Never sync peer cache");
      const deletions = sections.filter((m: any) => m.payload.section === "roomDeletions")
        .flatMap((m: any) => m.payload.data);
      expect(deletions).not.toContainEqual({ roomCode: otherCode, generation: 100, deletedAt: 300 });
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
    source.emit("message", "target", exportRequest("bad-token", "add", {
      roomDeletions: [{ roomCode: code, generation: 100, deletedAt: 300 }],
    }), pairing.roomCode);
    await vi.waitFor(() => expect(source.sent.some((m: any) => m.type === "sync_error")).toBe(true));
    expect((await storage.getRoom(code))?.createdAt).toBe(100);
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
    old.emit("message", "target", exportRequest(payload.token, "add"), payload.roomCode);
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    const spy = vi.spyOn(storage, "getDB").mockImplementationOnce(() => pending);
    try {
      void approveSync();
      await vi.waitFor(() => expect(spy).toHaveBeenCalled());
      await cancelSync();
      await generateSyncCode();
      const replacement = instances.at(-1);
      const replacementCode = syncState.plaintextToken;
      release(db);
      // Give the actual IndexedDB export time to drain its transactions.
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(replacement.sent).toHaveLength(0);
      expect(old.sent.filter((m: any) => m.type === "sync_export_data")).toHaveLength(0);
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

  it("does not carry a previous attempt's 100% into a new source session", async () => {
    await generateSyncCode();
    syncState.isComplete = true;
    syncState.syncProgress = 100;
    syncState.phase = "importing-remote";
    await generateSyncCode();
    expect(syncState.isComplete).toBe(false);
    expect(syncState.syncProgress).toBe(0);
    expect(syncState.phase).toBe("transfer");
    expect(syncState.plaintextToken).not.toBeNull();
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
    const frame = (token: string) => exportRequest(token, "replace");
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

  it("does not carry a previous attempt's completion into a new target session", async () => {
    syncState.isComplete = true;
    syncState.syncProgress = 100;
    syncState.phase = "importing";
    await connectAsTarget(payload());
    expect(syncState.isComplete).toBe(false);
    expect(syncState.syncProgress).toBe(0);
    expect(syncState.phase).toBe("transfer");
    expect(syncState.isConnecting).toBe(true);
  });

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

  /**
   * The account a merge proves it is: this device's own DID, and the
   * account key's signature over the source's peer id. Any session of the
   * account can make one, which in a test is this one.
   */
  async function sameAccount() {
    await storage.wipeLocalDatabase();
    const { createIdentity } = await import("$lib/identity/identity");
    const { keypair } = await createIdentity("same-account-test-password");
    return { did: keypair.did, binding: signPeerBinding(PEER_ID).bindingSig };
  }

  async function runTarget(mode: "add" | "replace") {
    const account = mode === "add" ? await sameAccount() : {};
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
        type: "sync_export_data", v: SYNC_PROTOCOL_VERSION,
        payload: { section: "identity", data: identitySection, token: TOKEN, seq: 0, ...account },
      })
    );
    await vi.waitFor(() => expect(t.sent.length).toBeGreaterThan(1));
    t.emit("message", PEER_ID, frame({ type: "sync_export_complete", v: SYNC_PROTOCOL_VERSION, payload: { manifest: manifest(), token: TOKEN } }));
    await vi.waitFor(() => expect(importCalls).toHaveLength(1));
    return importCalls[0];
  }

  it("passes received own overrides and leave markers to the importer", async () => {
    const account = await sameAccount();
    await connectAsTarget({ roomCode: SECURE_ROOM, roomSecret: SECURE_SECRET,
      token: TOKEN, expires: Date.now() + 60_000, peerId: PEER_ID, mode: "add" });
    const t = instances.at(-1);
    t.emit("connect", PEER_ID);
    t.emit("message", PEER_ID, frame({ type: "sync_export_data", v: SYNC_PROTOCOL_VERSION, payload: {
      section: "identity", token: TOKEN, seq: 0, ...account,
    } }));
    let seq = 1;
    for (const [section, record] of [
      ["roomProfiles", { roomCode: "room-a", did: "did:alice", generation: 100,
        fields: { nickname: null }, fieldEdits: { nickname: { at: 120, id: "a", reset: true } } }],
      ["roomDeletions", { roomCode: "room-b", generation: 100, deletedAt: 300 }],
    ] as const) {
      t.emit("message", PEER_ID, frame({ type: "sync_export_data", v: SYNC_PROTOCOL_VERSION, payload: {
        section, data: [record], token: TOKEN, batchIndex: 0, totalBatches: 1, seq: seq++,
      } }));
    }
    await vi.waitFor(() => expect(t.sent.filter((m: any) => m.type === "sync_export_ack")).toHaveLength(3));
    expect(t.sent.filter((m: any) => m.type === "sync_export_ack").map((m: any) => m.payload.seq)).toEqual([0, 1, 2]);
    t.emit("message", PEER_ID, frame({ type: "sync_export_complete", v: SYNC_PROTOCOL_VERSION, payload: {
      token: TOKEN,
      manifest: manifest({ roomProfiles: { items: 1, batches: 1 }, roomDeletions: { items: 1, batches: 1 } }),
    } }));
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

const ack = (seq: number) => encodeFrame({ type: "sync_export_ack", v: SYNC_PROTOCOL_VERSION, payload: { seq } });

/** A source device with an account and `messages` rows of history. */
async function sourceWithHistory(messages = 0) {
  const { createIdentity } = await import("$lib/identity/identity");
  await storage.wipeLocalDatabase();
  await createIdentity("source-test-password");
  if (messages > 0) {
    await storage.bulkPutMessages(Array.from({ length: messages }, (_, i) => ({
      id: `pace-${i}`, roomCode: "pacing-room-0001", senderId: "did:key:zPacer", senderName: "P",
      timestamp: i, lamport: i + 1, type: "text", content: `message ${i}`, attachments: [],
    })) as never);
  }
  await generateSyncCode();
  const t = instances.at(-1);
  const pairing = parsePlaintextToken(syncState.plaintextToken!)!;
  const ask = (peer: string, mode: "add" | "replace" = "add", extra: Record<string, unknown> = {}) =>
    t.emit("message", peer, exportRequest(pairing.token, mode, extra), pairing.roomCode);
  return { t, pairing, ask };
}

/** A source device in the sync room, without an account behind it. */
async function bareSource() {
  await generateSyncCode();
  const t = instances.at(-1);
  const pairing = parsePlaintextToken(syncState.plaintextToken!)!;
  const ask = (peer: string, mode: "add" | "replace" = "add", extra: Record<string, unknown> = {}) =>
    t.emit("message", peer, exportRequest(pairing.token, mode, extra), pairing.roomCode);
  return { t, pairing, ask };
}

// Holding the token used to be all it took: the first peer to ask with it got
// the whole account, and the real device's request was dropped without a word,
// leaving it at 0% until its watchdog fired. Anyone who saw the QR or the
// copied code holds the token.
describe("the source asks its user before it sends anything", () => {
  afterEach(async () => {
    markerControl.fail = false;
    vi.useRealTimers();
    await cancelSync();
    (await import("$lib/identity/identity")).lockIdentity();
  });

  it("answers a request with a code to compare, and nothing else", async () => {
    const { t, pairing, ask } = await bareSource();
    ask("target");
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    expect(t.sent.map((m: any) => m.type)).toEqual(["sync_approval_pending"]);
    const { nonce } = t.sent[0].payload;
    expect(nonce).toMatch(/^[0-9a-f]{32}$/);
    expect(syncState.pairingCode).toBe(syncComparisonCode(t.selfId(), "target", pairing.token, nonce));
    expect(syncState.isSyncing).toBe(false);
  });

  it("lets nothing an unapproved request carries touch this device", async () => {
    await storage.wipeLocalDatabase();
    await (await import("../storage-crypto")).initStorageCrypto(new Uint8Array(32).fill(33));
    const secret = newRoomSecret();
    const code = deriveRoomKeys(secret).discoveryId;
    // Rejoined here since the leave the request reports: an allowed request
    // would store its marker. One that is not allowed stores nothing.
    await storage.putRoom({ roomCode: code, roomSecret: secret, type: "text", name: "Here",
      createdAt: 400, lastSeenLamport: 0, participants: [] });
    const { t, ask } = await bareSource();
    ask("target", "add", { roomDeletions: [{ roomCode: code, generation: 100, deletedAt: 300 }] });
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    expect(await storage.getRoomDeletionMarker(code)).toBeUndefined();
    await denySync();
    expect(await storage.getRoomDeletionMarker(code)).toBeUndefined();
    expect(t.sent.filter((m: any) => m.type === "sync_export_data")).toHaveLength(0);
  });

  it("refuses a second requester out loud instead of leaving it waiting", async () => {
    const { t, ask } = await sourceWithHistory();
    ask("target");
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    ask("intruder");
    await vi.waitFor(() => expect(t.sentTo).toContain("intruder"));
    expect(t.sent[t.sentTo.indexOf("intruder")]).toMatchObject({
      type: "sync_error", payload: { error: expect.stringMatching(/Another device is already syncing/) },
    });
    // The first request is still the one being asked about.
    expect(syncState.awaitingApproval).toBe(true);
    await approveWhenAsked(t);
    await vi.waitFor(() => expect(t.sent.some((m: any) => m.type === "sync_export_complete")).toBe(true));
    ask("latecomer");
    await vi.waitFor(() => expect(t.sentTo).toContain("latecomer"));
    expect(t.sent[t.sentTo.indexOf("latecomer")].type).toBe("sync_error");
    // Every data frame went to the one device that was allowed.
    t.sent.forEach((m: any, i: number) => {
      if (m.type === "sync_export_data") expect(t.sentTo[i]).toBe("target");
    });
  });

  it("tells a denied requester, and spends the code", async () => {
    const { t, ask } = await bareSource();
    ask("intruder");
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    await denySync();
    expect(t.sentTo.at(-1)).toBe("intruder");
    expect(t.sent.at(-1)).toMatchObject({ type: "sync_error", payload: { error: expect.stringMatching(/declined/) } });
    expect(syncState.syncError).toMatch(/declined/);
    expect(syncState.awaitingApproval).toBe(false);
    const before = t.sent.length;
    ask("target");
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(t.sent).toHaveLength(before);
  });

  it("goes back to waiting when the requester gives up before an answer", async () => {
    const { t, pairing, ask } = await bareSource();
    ask("target");
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    t.emit("disconnect", "target");
    expect(syncState.awaitingApproval).toBe(false);
    expect(syncState.pairingCode).toBeNull();
    expect(syncState.isConnecting).toBe(true);
    ask("phone");
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    t.emit("message", "phone", encodeFrame({ type: "sync_error", v: SYNC_PROTOCOL_VERSION, payload: { error: "cancelled" } }), pairing.roomCode);
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(false));
    expect(syncState.syncError).toBeNull();
  });

  // Version 2 builds predate channels: they would show every channel's
  // messages mixed in one chat, so they are refused like version 1.
  it("refuses a version 2 request: that build has no channels", async () => {
    const { t, pairing } = await bareSource();
    t.emit("message", "older-target", encodeFrame({
      type: "sync_export_request", v: 2, payload: { token: pairing.token, mode: "add" },
    }), pairing.roomCode);
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    expect(t.sent[0]).toMatchObject({ type: "sync_error", payload: { error: SYNC_VERSION_MISMATCH } });
    expect(syncState.awaitingApproval).toBe(false);
  });

  it("refuses a version 1 request in words an old build shows", async () => {
    const { t, pairing } = await bareSource();
    t.emit("message", "old-target", encodeFrame({
      type: "sync_export_request", payload: { token: pairing.token, mode: "add" },
    }), pairing.roomCode);
    await vi.waitFor(() => expect(t.sent).toHaveLength(1));
    expect(t.sent[0]).toMatchObject({ type: "sync_error", payload: { error: SYNC_VERSION_MISMATCH } });
    expect(syncState.awaitingApproval).toBe(false);
  });

  it("ends with an error, not a spinner, when the target's leaves cannot be applied", async () => {
    markerControl.fail = true;
    const { t, ask } = await bareSource();
    ask("target", "add", { roomDeletions: [{ roomCode: "room-x", generation: 1, deletedAt: 2 }] });
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    await approveSync();
    expect(syncState.isSyncing).toBe(false);
    expect(syncState.syncError).toMatch(/room changes/);
    expect(t.sent.at(-1)).toMatchObject({ type: "sync_error" });
    expect(t.sent.filter((m: any) => m.type === "sync_export_data")).toHaveLength(0);
  });
});

describe("the export is paced on acks and closed with a manifest", () => {
  afterEach(async () => {
    vi.useRealTimers();
    await cancelSync();
    (await import("$lib/identity/identity")).lockIdentity();
  });

  const data = (t: any) => t.sent.filter((m: any) => m.type === "sync_export_data");

  it("has no more than a window of frames out unacknowledged", async () => {
    const { t, ask } = await sourceWithHistory(300);
    ask("target");
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    void approveSync();
    // The identity frame and three of the six message batches.
    await vi.waitFor(() => expect(data(t)).toHaveLength(4));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(data(t)).toHaveLength(4);
    t.emit("message", "target", ack(data(t)[0].payload.seq));
    await vi.waitFor(() => expect(data(t)).toHaveLength(5));
    const unanswered = data(t).slice(1);
    t.autoAck = "target";
    for (const m of unanswered) t.emit("message", "target", ack(m.payload.seq));
    await vi.waitFor(() => expect(t.sent.some((m: any) => m.type === "sync_export_complete")).toBe(true));
    const { manifest: listed } = t.sent.find((m: any) => m.type === "sync_export_complete").payload;
    expect(listed.messages).toEqual({ items: 300, batches: 6 });
    // Empty sections are listed too: an absent one is what a lost frame looks like.
    for (const name of EXPORT_SECTIONS) expect(listed).toHaveProperty(name);
    expect(listed.localState).toEqual({ items: 1, batches: 1 });
  });

  it("says who it is in a merge, with a binding only the account key could sign", async () => {
    const { t, ask } = await sourceWithHistory();
    ask("target", "add");
    await approveWhenAsked(t);
    await vi.waitFor(() => expect(data(t).length).toBeGreaterThan(0));
    const identity = data(t)[0].payload;
    expect(identity.section).toBe("identity");
    expect(identity.data).toBeUndefined();
    expect(identity.did).toBe((await storage.getKeypairRecord())?.did);
    const { verifyPeerBinding } = await import("$lib/messaging");
    expect(await verifyPeerBinding(identity.did, t.selfId(), identity.binding)).toBe(true);
  });

  it("waits for a target lost mid-transfer, and gives up when it stays gone", async () => {
    const { t, ask } = await sourceWithHistory(300);
    ask("target");
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    void approveSync();
    await vi.waitFor(() => expect(data(t)).toHaveLength(4));
    t.emit("disconnect", "target");
    expect(syncState.reconnecting).toBe(true);
    expect(syncState.syncError).toBeNull();
    await vi.advanceTimersByTimeAsync(59_000);
    expect(syncState.syncError).toBeNull();
    // Nobody there to send anything again to.
    expect(data(t)).toHaveLength(4);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(syncState.syncError).toMatch(/while sending/);
    expect(syncState.isSyncing).toBe(false);
    expect(syncState.reconnecting).toBe(false);
  });

  it("sends what was on the way again when a lost target comes back, and finishes", async () => {
    const { t, ask } = await sourceWithHistory(300);
    ask("target");
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    void approveSync();
    await vi.waitFor(() => expect(data(t)).toHaveLength(4));
    t.emit("message", "target", ack(0));
    await vi.waitFor(() => expect(data(t)).toHaveLength(5));
    t.emit("disconnect", "target");
    t.autoAck = "target";
    t.emit("connect", "target");
    await vi.waitFor(() => expect(t.sent.some((m: any) => m.type === "sync_export_complete")).toBe(true));
    const seqs = data(t).map((m: any) => m.payload.seq);
    // The unconfirmed four again, the confirmed one not.
    expect(seqs.filter((n: number) => n === 0)).toHaveLength(1);
    for (const again of [1, 2, 3, 4]) expect(seqs.filter((n: number) => n === again)).toHaveLength(2);
    expect(syncState.syncError).toBeNull();
  });

  // The reported stall: the sender at 83% and the new device at 10%. The path
  // under the channel stopped carrying frames and nothing said so.
  it("leaves a channel nothing is heard from, and sends again on another", async () => {
    const { t, ask } = await sourceWithHistory(5);
    ask("target");
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    t.autoAck = "target";
    t.blackhole = true;
    void approveSync();
    await vi.waitFor(() => expect(data(t)).toHaveLength(3));
    await vi.advanceTimersByTimeAsync(7_000);
    expect(t.reopened).toEqual([]);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(t.reopened).toEqual(["target"]);
    await vi.waitFor(() => expect(t.sent.some((m: any) => m.type === "sync_export_complete")).toBe(true));
    expect(syncState.syncError).toBeNull();
  });

  it("sends the close again until the target says anything", async () => {
    const { t, pairing, ask } = await sourceWithHistory();
    ask("target");
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    t.autoAck = "target";
    void approveSync();
    const closes = () => t.sent.filter((m: any) => m.type === "sync_export_complete").length;
    await vi.waitFor(() => expect(closes()).toBe(1));
    await vi.advanceTimersByTimeAsync(8_500);
    expect(closes()).toBe(2);
    t.emit("message", "target", encodeFrame({ type: "sync_awaiting_password", v: SYNC_PROTOCOL_VERSION }), pairing.roomCode);
    await vi.waitFor(() => expect(syncState.phase).toBe("remote-password"));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(closes()).toBe(2);
    expect(syncState.syncError).toBeNull();
  });

  it("does not time a target that is away, and times it again once it is back", async () => {
    const { t, pairing, ask } = await sourceWithHistory();
    ask("target");
    await approveWhenAsked(t);
    await vi.waitFor(() => expect(t.sent.some((m: any) => m.type === "sync_export_complete")).toBe(true));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    t.emit("message", "target", encodeFrame({ type: "sync_import_progress", v: SYNC_PROTOCOL_VERSION, payload: { percent: 92 } }), pairing.roomCode);
    await vi.waitFor(() => expect(syncState.syncProgress).toBe(92));
    await vi.advanceTimersByTimeAsync(75_000);
    t.emit("disconnect", "target");
    await vi.advanceTimersByTimeAsync(59_000);
    expect(syncState.syncError).toBeNull();
    t.emit("connect", "target");
    await vi.advanceTimersByTimeAsync(100_000);
    expect(syncState.syncError).toBeNull();
    t.emit("message", "target", encodeFrame({ type: "sync_export_complete", v: SYNC_PROTOCOL_VERSION }), pairing.roomCode);
    await vi.waitFor(() => expect(syncState.isComplete).toBe(true));
  });

  it("sends again at once when the channel closes, a few times, and no more without an ack", async () => {
    const { t, ask } = await sourceWithHistory(5);
    ask("target");
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    void approveSync();
    await vi.waitFor(() => expect(data(t)).toHaveLength(3));
    for (let i = 1; i <= 6; i++) {
      t.onChannelLost("somebody else");
      t.onChannelLost("target");
      await vi.advanceTimersByTimeAsync(10);
    }
    expect(data(t)).toHaveLength(3 * 4);
    t.emit("message", "target", ack(0));
    t.onChannelLost("target");
    await vi.advanceTimersByTimeAsync(10);
    expect(data(t)).toHaveLength(3 * 4 + 2);
  });

  it("answers a request asked again after Allow over the channel it came on", async () => {
    const { t, ask } = await sourceWithHistory(5);
    ask("target");
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    void approveSync();
    await vi.waitFor(() => expect(data(t).length).toBeGreaterThanOrEqual(3));
    const before = data(t).length;
    ask("target");
    await vi.waitFor(() => expect(data(t)).toHaveLength(before * 2));
    expect(t.reopened).toEqual([]);
    expect(syncState.awaitingApproval).toBe(false);
  });

  it("stops after two minutes with no word at all, however often it sent again", async () => {
    const { t, ask } = await sourceWithHistory(300);
    ask("target");
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    void approveSync();
    await vi.waitFor(() => expect(data(t)).toHaveLength(4));
    await vi.advanceTimersByTimeAsync(121_000);
    expect(syncState.syncError).toMatch(/stopped taking in the data/);
    const sent = t.sent.length;
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(t.sent).toHaveLength(sent);
    expect(vi.getTimerCount()).toBe(0);
  });

  // The receiver's disconnect used to win over everything: a "Connection
  // lost" said while the other device imported stuck, even over a success.
  it("lets a late confirmation replace a connection lost during the remote import", async () => {
    const { t, pairing, ask } = await sourceWithHistory();
    ask("target");
    await approveWhenAsked(t);
    await vi.waitFor(() => expect(t.sent.some((m: any) => m.type === "sync_export_complete")).toBe(true));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    t.emit("disconnect", "target");
    expect(syncState.syncError).toBeNull();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(syncState.syncError).toMatch(/while the other device was importing/);
    vi.useRealTimers();
    t.emit("message", "target", encodeFrame({ type: "sync_export_complete", v: SYNC_PROTOCOL_VERSION }), pairing.roomCode);
    await vi.waitFor(() => expect(syncState.isComplete).toBe(true));
    expect(syncState.syncError).toBeNull();
  });

  it("keeps waiting on the password through the link's keepalive", async () => {
    const { t, pairing, ask } = await sourceWithHistory();
    ask("target", "replace");
    await approveWhenAsked(t);
    await vi.waitFor(() => expect(t.sent.some((m: any) => m.type === "sync_export_complete")).toBe(true));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    t.emit("message", "target", encodeFrame({ type: "sync_awaiting_password", v: SYNC_PROTOCOL_VERSION }), pairing.roomCode);
    await vi.waitFor(() => expect(syncState.phase).toBe("remote-password"));
    // A ping is the link, not the import resuming: it must not restart the
    // clock that a person typing a password is exempt from.
    t.emit("message", "target", new TextEncoder().encode(JSON.stringify({ type: "__ping", n: 1 })), pairing.roomCode);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(syncState.syncError).toBeNull();
    expect(syncState.phase).toBe("remote-password");
  });

  // The receiver's password prompt sends nothing for as long as a person
  // takes to type, and the source's 120-second clock used to disconnect a
  // sync that was waiting on exactly that.
  it("stops timing the target while its user types a password, and starts again after", async () => {
    const { t, pairing, ask } = await sourceWithHistory();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    ask("target", "replace");
    await approveWhenAsked(t);
    await vi.waitFor(() => expect(t.sent.some((m: any) => m.type === "sync_export_complete")).toBe(true));
    t.emit("message", "target", encodeFrame({ type: "sync_awaiting_password", v: SYNC_PROTOCOL_VERSION }), pairing.roomCode);
    await vi.waitFor(() => expect(syncState.phase).toBe("remote-password"));
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(syncState.syncError).toBeNull();
    t.emit("message", "target", encodeFrame({ type: "sync_import_progress", v: SYNC_PROTOCOL_VERSION, payload: { percent: 95 } }), pairing.roomCode);
    await vi.advanceTimersByTimeAsync(119_000);
    expect(syncState.syncError).toBeNull();
    await vi.advanceTimersByTimeAsync(2_000);
    expect(syncState.syncError).toMatch(/never confirmed the import/);
  });
});

describe("the target confirms, checks and reports", () => {
  afterEach(async () => {
    importControl.run = null;
    importCalls.length = 0;
    vi.useRealTimers();
    await cancelSync();
    (await import("$lib/identity/identity")).lockIdentity();
  });

  const IDENTITY = {
    mnemonic: { salt: [1], iv: [2], encrypted: [3], iterations: 600_000 },
    keypair: { did: "did:key:zTheAccount", publicKey: [4] },
  };

  async function target(mode: "add" | "replace" = "replace", options: Parameters<typeof connectAsTarget>[1] = {}) {
    await connectAsTarget({ roomCode: SECURE_ROOM, roomSecret: SECURE_SECRET, token: TOKEN,
      expires: Date.now() + 60_000, peerId: PEER_ID, mode }, options);
    const t = instances.at(-1);
    t.emit("connect", PEER_ID);
    return t;
  }
  const fromSource = (t: any, obj: unknown) => t.emit("message", PEER_ID, encodeFrame(obj));
  const identityFrame = (extra: Record<string, unknown> = {}) => ({ type: "sync_export_data", v: SYNC_PROTOCOL_VERSION,
    payload: { section: "identity", data: IDENTITY, token: TOKEN, seq: 0, ...extra } });
  const complete = (counts: Record<string, { items: number; batches: number }> = {}) =>
    ({ type: "sync_export_complete", v: SYNC_PROTOCOL_VERSION, payload: { manifest: manifest(counts), token: TOKEN } });

  it("shows the code the source computed, and does not time out while that user decides", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = await target();
    const nonce = "c".repeat(32);
    fromSource(t, { type: "sync_approval_pending", v: SYNC_PROTOCOL_VERSION, payload: { nonce } });
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    expect(syncState.pairingCode).toBe(syncComparisonCode(PEER_ID, t.selfId(), TOKEN, nonce));
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(syncState.syncError).toBeNull();
    // Allowed: the data starts, and from here silence is a stall again.
    fromSource(t, identityFrame());
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(false));
    expect(syncState.pairingCode).toBeNull();
    await vi.advanceTimersByTimeAsync(61_000);
    expect(syncState.syncError).toMatch(/stopped sending/);
  });

  it("refuses a version 1 source's data and says why on both ends", async () => {
    const t = await target();
    fromSource(t, { type: "sync_export_data", payload: { section: "identity", data: IDENTITY, token: TOKEN } });
    await vi.waitFor(() => expect(syncState.syncError).toBe(SYNC_VERSION_MISMATCH));
    expect(t.sent.at(-1)).toMatchObject({ type: "sync_error", payload: { error: SYNC_VERSION_MISMATCH } });
    expect(importCalls).toHaveLength(0);
  });

  // The transport's keepalive rides the secure room too, with no version.
  it("ignores the link's keepalive while waiting for the source's user", async () => {
    const t = await target();
    fromSource(t, { type: "sync_approval_pending", v: SYNC_PROTOCOL_VERSION, payload: { nonce: "d".repeat(32) } });
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    fromSource(t, { type: "__ping", n: 1 });
    fromSource(t, null);
    fromSource(t, identityFrame());
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(false));
    expect(syncState.syncError).toBeNull();
  });

  it("refuses a merge from a different account before anything is written", async () => {
    await storage.wipeLocalDatabase();
    const { createIdentity } = await import("$lib/identity/identity");
    await createIdentity("this-account-password");
    const t = await target("add");
    fromSource(t, identityFrame({ data: undefined, did: "did:key:zSomebodyElse", binding: "00".repeat(64) }));
    await vi.waitFor(() => expect(syncState.syncError).toBe(DIFFERENT_ACCOUNT_MERGE));
    expect(t.sent.at(-1)).toMatchObject({ type: "sync_error" });
    fromSource(t, complete());
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(importCalls).toHaveLength(0);
  });

  it("refuses this account's DID when the source cannot sign for it", async () => {
    await storage.wipeLocalDatabase();
    const { createIdentity } = await import("$lib/identity/identity");
    const { keypair } = await createIdentity("this-account-password");
    const t = await target("add");
    fromSource(t, identityFrame({ data: undefined, did: keypair.did, binding: "00".repeat(64) }));
    await vi.waitFor(() => expect(syncState.syncError).toBe(DIFFERENT_ACCOUNT_MERGE));
    expect(importCalls).toHaveLength(0);
  });

  it("hands the proven account to the importer, which checks it again", async () => {
    await storage.wipeLocalDatabase();
    const { createIdentity } = await import("$lib/identity/identity");
    const { keypair } = await createIdentity("this-account-password");
    const t = await target("add");
    fromSource(t, identityFrame({ data: undefined, did: keypair.did, binding: signPeerBinding(PEER_ID).bindingSig }));
    fromSource(t, complete());
    await vi.waitFor(() => expect(importCalls).toHaveLength(1));
    expect(importCalls[0].options.sourceDid).toBe(keypair.did);
  });

  it("refuses a transfer that holds less than the manifest lists, before importing", async () => {
    const t = await target();
    fromSource(t, identityFrame());
    fromSource(t, { type: "sync_export_data", v: SYNC_PROTOCOL_VERSION, payload: { section: "messages",
      data: [{ id: "m1" }], batchIndex: 0, totalBatches: 2, token: TOKEN, seq: 1 } });
    // rooms: one batch announced in the manifest, and its frame never came.
    fromSource(t, complete({ messages: { items: 2, batches: 2 }, rooms: { items: 1, batches: 1 } }));
    await vi.waitFor(() => expect(syncState.syncError).toMatch(/arrived incomplete/));
    expect(syncState.syncError).toContain("messages (1/2)");
    expect(syncState.syncError).toContain("rooms (0/1)");
    expect(importCalls).toHaveLength(0);
  });

  it("keeps a batch that arrives twice once", async () => {
    const t = await target();
    fromSource(t, identityFrame());
    const batch = { type: "sync_export_data", v: SYNC_PROTOCOL_VERSION, payload: { section: "rooms",
      data: [{ roomCode: "r1", type: "text" }], batchIndex: 0, totalBatches: 1, token: TOKEN, seq: 1 } };
    fromSource(t, batch);
    fromSource(t, { ...batch, payload: { ...batch.payload, seq: 2 } });
    fromSource(t, complete({ rooms: { items: 1, batches: 1 } }));
    await vi.waitFor(() => expect(importCalls).toHaveLength(1));
    expect(importCalls[0].data.rooms).toHaveLength(1);
  });

  it("tells the source while it waits for the password, and when it is working again", async () => {
    let answer!: (password: string | null) => void;
    importControl.run = async (options) => {
      expect(await options.requestPassword(false)).toBe("the password");
      options.beforeCommit();
    };
    const t = await target("replace", {
      requestPassword: () => new Promise((resolve) => { answer = resolve; }),
    });
    fromSource(t, identityFrame());
    fromSource(t, complete());
    await vi.waitFor(() => expect(t.sent.some((m: any) => m.type === "sync_awaiting_password")).toBe(true));
    answer("the password");
    await vi.waitFor(() => expect(syncState.isComplete).toBe(true));
    const types = t.sent.map((m: any) => m.type);
    expect(types.indexOf("sync_import_progress", types.indexOf("sync_awaiting_password")))
      .toBeGreaterThan(types.indexOf("sync_awaiting_password"));
  });

  it("cannot be cancelled past the commit point, and still reports how it ended", async () => {
    let finish!: () => void;
    const writes = new Promise<void>((resolve) => { finish = resolve; });
    importControl.run = async (options) => {
      options.beforeCommit();
      await writes;
    };
    const t = await target();
    fromSource(t, identityFrame());
    fromSource(t, complete());
    await vi.waitFor(() => expect(syncState.finishing).toBe(true));
    await cancelSync();
    expect(syncState.finishing).toBe(true);
    finish();
    await vi.waitFor(() => expect(syncState.isComplete).toBe(true));
    expect(syncState.finishing).toBe(false);
    expect(syncState.syncError).toBeNull();
    expect(t.sent.some((m: any) => m.type === "sync_export_complete")).toBe(true);
  });

  it("says what state the device is in when a committed replace fails part way", async () => {
    importControl.run = async (options) => {
      options.beforeCommit();
      throw new Error("QuotaExceededError");
    };
    const t = await target("replace");
    fromSource(t, identityFrame());
    fromSource(t, complete());
    await vi.waitFor(() => expect(syncState.syncError).toMatch(/previous data was already erased/));
    expect(syncState.syncError).toContain("QuotaExceededError");
    expect(syncState.finishing).toBe(false);
    expect(syncState.isSyncing).toBe(false);
    expect(t.sent.at(-1)).toMatchObject({ type: "sync_error" });
  });

  it("does not call a relay's disconnect a lost sync, nor the source's once the data is in", async () => {
    let finish!: () => void;
    const writes = new Promise<void>((resolve) => { finish = resolve; });
    importControl.run = async (options) => {
      options.beforeCommit();
      await writes;
    };
    const t = await target();
    t.emit("disconnect", "12D3KooW" + "R".repeat(44));
    expect(syncState.syncError).toBeNull();
    fromSource(t, identityFrame());
    fromSource(t, complete());
    await vi.waitFor(() => expect(syncState.finishing).toBe(true));
    t.emit("disconnect", PEER_ID);
    // Nor an error frame from a source that gave up waiting.
    fromSource(t, { type: "sync_error", v: SYNC_PROTOCOL_VERSION, payload: { error: "The other device never confirmed the import" } });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(syncState.syncError).toBeNull();
    // Told when it is back, or not for long: everything is written here.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    finish();
    await vi.advanceTimersByTimeAsync(10_500);
    await vi.waitFor(() => expect(syncState.isComplete).toBe(true));
    expect(syncState.syncError).toBeNull();
  });

  it("waits for a source lost mid-transfer, and takes the rest when it is back", async () => {
    const t = await target();
    fromSource(t, identityFrame());
    await vi.waitFor(() => expect(t.sent.some((m: any) => m.type === "sync_export_ack")).toBe(true));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    t.emit("disconnect", PEER_ID);
    expect(syncState.reconnecting).toBe(true);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(syncState.syncError).toBeNull();
    t.emit("connect", PEER_ID);
    expect(syncState.reconnecting).toBe(false);
    // It does not ask for the whole export over again.
    expect(t.sent.filter((m: any) => m.type === "sync_export_request")).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(syncState.syncError).toBeNull();
    vi.useRealTimers();
    fromSource(t, identityFrame());
    fromSource(t, complete());
    await vi.waitFor(() => expect(syncState.isComplete).toBe(true));
  });

  it("gives up on a source that stays gone, with nothing changed", async () => {
    const t = await target();
    fromSource(t, identityFrame());
    await vi.waitFor(() => expect(t.sent.some((m: any) => m.type === "sync_export_ack")).toBe(true));
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    t.emit("disconnect", PEER_ID);
    await vi.advanceTimersByTimeAsync(61_000);
    expect(syncState.syncError).toMatch(/Lost the connection/);
    expect(syncState.isSyncing).toBe(false);
    expect(importCalls).toHaveLength(0);
  });

  it("asks again when the source went away before it answered", async () => {
    const t = await target();
    await vi.waitFor(() => expect(t.sent.filter((m: any) => m.type === "sync_export_request")).toHaveLength(1));
    fromSource(t, { type: "sync_approval_pending", v: SYNC_PROTOCOL_VERSION, payload: { nonce: "ab".repeat(16) } });
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    t.emit("disconnect", PEER_ID);
    expect(syncState.pairingCode).toBeNull();
    expect(syncState.isConnecting).toBe(true);
    t.emit("connect", PEER_ID);
    await vi.waitFor(() => expect(t.sent.filter((m: any) => m.type === "sync_export_request")).toHaveLength(2));
    expect(syncState.syncError).toBeNull();
  });

  it("asks again when a request the link took is not answered, until it is", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = await target();
    const requests = () => t.sent.filter((m: any) => m.type === "sync_export_request").length;
    await vi.waitFor(() => expect(requests()).toBe(1));
    await vi.advanceTimersByTimeAsync(8_500);
    expect(requests()).toBe(2);
    expect(t.reopened).toEqual([PEER_ID]);
    fromSource(t, { type: "sync_approval_pending", v: SYNC_PROTOCOL_VERSION, payload: { nonce: "cd".repeat(16) } });
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(requests()).toBe(2);
  });

  it("says again where its import is to a source that closes twice", async () => {
    importControl.run = async (options) => { await options.requestPassword(false); options.beforeCommit(); };
    let answer!: (password: string) => void;
    const t = await target("replace", { requestPassword: () => new Promise((resolve) => { answer = resolve; }) });
    fromSource(t, identityFrame());
    fromSource(t, complete());
    const waits = () => t.sent.filter((m: any) => m.type === "sync_awaiting_password").length;
    await vi.waitFor(() => expect(waits()).toBe(1));
    fromSource(t, complete());
    await vi.waitFor(() => expect(waits()).toBe(2));
    expect(importCalls).toHaveLength(1);
    answer("pw");
    await vi.waitFor(() => expect(syncState.isComplete).toBe(true));
  });

  it("makes sure a source that missed it hears the import is done, then ends anyway", async () => {
    const t = await target();
    t.autoDone = false;
    const dones = () => t.sent.filter((m: any) => m.type === "sync_export_complete").length;
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    fromSource(t, identityFrame());
    fromSource(t, complete());
    await vi.waitFor(() => expect(dones()).toBe(1));
    expect(syncState.isComplete).toBe(false);
    await vi.advanceTimersByTimeAsync(4_500);
    expect(dones()).toBe(2);
    expect(t.reopened).toEqual([PEER_ID]);
    await vi.advanceTimersByTimeAsync(4_000);
    await vi.waitFor(() => expect(syncState.isComplete).toBe(true));
    expect(syncState.syncError).toBeNull();
  });

  it("ends at once when the source says it heard, or leaves as an older build does", async () => {
    for (const how of ["says", "leaves"] as const) {
      const t = await target();
      t.autoDone = false;
      fromSource(t, identityFrame());
      fromSource(t, complete());
      await vi.waitFor(() => expect(t.sent.some((m: any) => m.type === "sync_export_complete")).toBe(true));
      if (how === "says") fromSource(t, { type: "sync_done", v: SYNC_PROTOCOL_VERSION });
      else t.emit("disconnect", PEER_ID);
      await vi.waitFor(() => expect(syncState.isComplete).toBe(true));
    }
  });

  it("does not end a session over a request from before the link dropped", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = await target();
    t.sent.length = 0;
    t.emit("disconnect", PEER_ID);
    // The first asks three times and is refused three times, across a return.
    t.sendResults = [false, false];
    t.emit("connect", PEER_ID);
    await vi.advanceTimersByTimeAsync(1_000);
    t.emit("disconnect", PEER_ID);
    t.sendResults = [];
    t.emit("connect", PEER_ID);
    await vi.advanceTimersByTimeAsync(100);
    fromSource(t, { type: "sync_approval_pending", v: SYNC_PROTOCOL_VERSION, payload: { nonce: "ef".repeat(16) } });
    await vi.waitFor(() => expect(syncState.awaitingApproval).toBe(true));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(syncState.syncError).toBeNull();
    expect(syncState.awaitingApproval).toBe(true);
  });

  it("leaves no timer behind when cancelled while its request goes out", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = await target();
    await vi.advanceTimersByTimeAsync(0);
    await cancelSync();
    await vi.advanceTimersByTimeAsync(60_000);
    const sent = t.sent.length;
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(t.sent).toHaveLength(sent);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("tells the source when it gives up, so that one does not wait for it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const t = await target();
    fromSource(t, identityFrame());
    await vi.waitFor(() => expect(t.sent.some((m: any) => m.type === "sync_export_ack")).toBe(true));
    await vi.advanceTimersByTimeAsync(61_000);
    expect(syncState.syncError).toMatch(/stopped sending/);
    expect(t.sent.some((m: any) => m.type === "sync_error")).toBe(true);
  });

  it("tells a source that was away when the import ended, once it is back", async () => {
    const t = await target();
    t.autoDone = false;
    let finish!: () => void;
    importControl.run = async (options) => { options.beforeCommit(); await new Promise<void>((r) => { finish = r; }); };
    fromSource(t, identityFrame());
    fromSource(t, complete());
    await vi.waitFor(() => expect(syncState.finishing).toBe(true));
    t.emit("disconnect", PEER_ID);
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    finish();
    const dones = () => t.sent.filter((m: any) => m.type === "sync_export_complete").length;
    await vi.advanceTimersByTimeAsync(8_000);
    expect(dones()).toBe(0);
    t.emit("connect", PEER_ID);
    await vi.waitFor(() => expect(dones()).toBe(1));
    fromSource(t, { type: "sync_done", v: SYNC_PROTOCOL_VERSION });
    await vi.waitFor(() => expect(syncState.isComplete).toBe(true));
  });
});
