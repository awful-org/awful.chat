import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveRoomKeys, newRoomSecret } from "$lib/room-security/keys";

const SECRET = newRoomSecret();
const ROOM = deriveRoomKeys(SECRET).discoveryId;
const HASH = "a".repeat(40);
const FILE = { infoHash: HASH, filename: "private.txt", mimeType: "text/plain", size: 6,
  encryption: { version: 2 as const, key: "A".repeat(43), id: "A".repeat(22), size: 6, chunkSize: 1048576 } };
const offer = (file = FILE) => ({ type: "__file_signal", payload: { kind: "file-seeder", file } });
const frame = (v: unknown) => new TextEncoder().encode(JSON.stringify(v));
class Events {
  handlers = new Map<string, Function[]>();
  on(event: string, fn: Function) { this.handlers.set(event, [...this.handlers.get(event) ?? [], fn]); }
  emit(event: string, ...args: unknown[]) { for (const fn of this.handlers.get(event) ?? []) fn(...args); }
}
class FakeTransport extends Events {
  members = new Set<string>();
  connect = vi.fn(async () => {});
  disconnect = vi.fn(async () => {});
  joinSecureRoom = vi.fn();
  leaveRoom = vi.fn();
  sendRoom = vi.fn(async (_peer: string, _room: string, _data: Uint8Array) => true);
  isRoomPeer(room: string, peer: string) { return room === ROOM && this.members.has(peer); }
  peersInRoom() { return [...this.members]; }
  selfId() { return "self"; }
  message(v: unknown, room: string | undefined = ROOM, peer = "friend") { this.emit("message", peer, frame(v), room); }
}
class FakeFiles extends Events {
  lookup?: (hash: string) => Promise<File | null>;
  setLocalFileLookup(fn: typeof this.lookup) { this.lookup = fn; }
  seedEncryptedFiles = vi.fn(async (_files: File[]) => [FILE]);
  onPeerConnect = vi.fn();
  onPeerDisconnect = vi.fn();
  handleSignal = vi.fn();
  ensureDownload = vi.fn();
  destroy = vi.fn();
}
let t: FakeTransport;
let f: FakeFiles;
vi.mock("$lib/transport/libp2p/transport", () => ({ LibP2PTransport: class { constructor() { return t; } } }));
vi.mock("$lib/transport/file/webtorrent", () => ({ WebTorrentFileTransport: class { constructor() { return f; } } }));
vi.mock("$lib/transport/file/ciphertext-store", () => ({ removeCiphertext: vi.fn(async () => {}) }));
vi.mock("$lib/transport/ice-server-list", () => ({ refreshTurnCredentials: async () => {} }));
vi.mock("$lib/runtime-config", () => ({ isConfigured: () => true }));
let qs: typeof import("./quick-send.svelte");
beforeEach(async () => {
  vi.resetModules(); t = new FakeTransport(); f = new FakeFiles();
  qs = await import("./quick-send.svelte");
});
afterEach(() => { qs.stopQuickSend(); vi.unstubAllGlobals(); });
async function start() {
  await qs.startQuickSend(SECRET); t.members.add("friend"); t.emit("roomPeers", ROOM, ["friend"]);
}
function sent() { return t.sendRoom.mock.calls.map(([, room, data]) => ({ room, msg: JSON.parse(new TextDecoder().decode(data)) })); }

describe("protected quick send", () => {
  it("joins a validated capability and sends only on the derived room", async () => {
    await start(); expect(t.joinSecureRoom).toHaveBeenCalledWith(SECRET);
    await qs.offerFiles([new File(["secret"], "private.txt")]);
    expect(f.seedEncryptedFiles).toHaveBeenCalledOnce();
    expect(sent()).toContainEqual({ room: ROOM, msg: offer() });
    expect(await f.lookup?.(HASH)).toBeNull();
  });
  it("mints a high-entropy capability", async () => {
    await qs.startQuickSend(); expect(qs.quickSend.code).toMatch(/^r2_[A-Za-z0-9_-]{43}$/);
    expect(qs.quickSend.isHost).toBe(true);
  });
  it.each(["7QK3M9AB2C", ROOM, "", `${SECRET}junk`])("rejects non-capability %s without fallback", async code => {
    await qs.startQuickSend(code); expect(qs.quickSend.status).toBe("failed");
    expect(t.connect).not.toHaveBeenCalled();
  });
  it("does not treat relay discovery as membership", async () => {
    await qs.startQuickSend(SECRET);
    t.emit("roomPeers", ROOM, ["stranger"]); t.emit("connect", "stranger"); t.message(offer(), ROOM, "stranger");
    expect(f.onPeerConnect).not.toHaveBeenCalled(); expect(f.handleSignal).not.toHaveBeenCalled();
    expect(t.sendRoom).not.toHaveBeenCalled();
  });
  it("rejects wrong-room and unauthenticated frames from a real member", async () => {
    await start(); t.message(offer(), "rd2_wrong"); t.emit("message", "friend", frame(offer()));
    expect(qs.quickSend.incoming).toEqual([]); expect(f.handleSignal).not.toHaveBeenCalled();
  });
  it("surfaces protected offers and downloads only after consent", async () => {
    await start(); t.message(offer()); expect(qs.quickSend.incoming).toEqual([FILE]);
    expect(f.ensureDownload).not.toHaveBeenCalled(); qs.acceptFile("unknown"); expect(f.ensureDownload).not.toHaveBeenCalled();
    qs.acceptFile(HASH); expect(f.ensureDownload).toHaveBeenCalledWith(FILE, { retry: false });
  });
  it("rejects plaintext, malformed signals and descriptor substitution", async () => {
    await start();
    for (const payload of [{ kind: "file-seeder" }, { kind: "file-seeder", file: { ...FILE, encryption: undefined } },
      { kind: "file-seeder", file: { ...FILE, size: 7 } }, { kind: "file-seeder", file: { ...FILE, infoHash: "bad" } },
      { kind: "file-wt-signal", infoHash: HASH, signal: {} }, { kind: "unknown", infoHash: HASH }]) {
      expect(() => t.message({ type: "__file_signal", payload })).not.toThrow();
    }
    expect(f.handleSignal).not.toHaveBeenCalled();
    t.message(offer()); t.message(offer({ ...FILE, filename: "substituted.txt" }));
    t.message(offer({ ...FILE, encryption: { ...FILE.encryption, key: "B".repeat(42) + "A" } }));
    expect(f.handleSignal).toHaveBeenCalledOnce(); expect(qs.quickSend.incoming).toEqual([FILE]);
  });
  it("announces the retained ciphertext after authentication without reseeding plaintext", async () => {
    await start(); t.message(offer()); qs.acceptFile(HASH); t.sendRoom.mockClear();
    f.emit("downloaded", HASH, new Blob(["secret"]));
    expect(sent()).toContainEqual({ room: ROOM, msg: offer() });
    expect(f.seedEncryptedFiles).not.toHaveBeenCalled(); expect(await f.lookup?.(HASH)).toBeNull();
  });
  it.each(["once", "save-data"])("does not reshare received ciphertext under %s", async mode => {
    await start();
    if (mode === "once") { t.message({ type: "__qs_mode", mode: "once" }); t.message({ type: "__qs_mode", mode: "multi" }); }
    else vi.stubGlobal("navigator", { connection: { saveData: true } });
    t.message(offer()); qs.acceptFile(HASH); t.sendRoom.mockClear(); f.emit("downloaded", HASH, new Blob(["secret"]));
    f.emit("signal", "friend", { kind: "file-seeder", file: FILE });
    expect(sent().map(s => s.msg)).toEqual([{ type: "__qs_ack", infoHash: HASH }]);
    expect(f.onPeerDisconnect).toHaveBeenCalledWith("friend");
    f.handleSignal.mockClear(); t.message({ type: "__file_signal", payload: { kind: "file-wt-signal", infoHash: HASH, signal: {} } });
    expect(f.handleSignal).not.toHaveBeenCalled();
  });
  it("closes a once link only for an authenticated acknowledgement of its offer", async () => {
    await start(); qs.setQuickSendMode("once"); await qs.offerFiles([new File(["secret"], "private.txt")]);
    t.message({ type: "__qs_ack", infoHash: HASH }, "wrong"); expect(qs.quickSend.closed).toBe(false);
    t.message({ type: "__qs_ack", infoHash: "b".repeat(40) }); expect(qs.quickSend.closed).toBe(false);
    t.message({ type: "__qs_ack", infoHash: HASH }); expect(qs.quickSend.closed).toBe(true);
    expect(t.leaveRoom).toHaveBeenCalledWith(ROOM); expect(f.onPeerDisconnect).toHaveBeenCalledWith("friend");
  });
  it("unwires revoked members and rejects their subsequent frames", async () => {
    await start(); t.members.clear(); t.emit("roomPeers", ROOM, []); t.message(offer());
    expect(f.onPeerDisconnect).toHaveBeenCalledWith("friend"); expect(qs.quickSend.incoming).toEqual([]);
  });
  it("invalid replacement tears down the old session and stale callbacks cannot revive it", async () => {
    await start(); await qs.startQuickSend("bad"); f.emit("transfer", { infoHash: HASH }); t.message(offer());
    expect(t.disconnect).toHaveBeenCalled(); expect(f.destroy).toHaveBeenCalled();
    expect(qs.quickSend.transfers.size).toBe(0); expect(qs.quickSend.incoming).toEqual([]);
  });
  it("stopping while connect is pending prevents late joins", async () => {
    let finish!: () => void; t.connect.mockImplementationOnce(() => new Promise(r => { finish = r; }));
    const pending = qs.startQuickSend(SECRET); qs.stopQuickSend(); finish(); await pending;
    expect(t.joinSecureRoom).not.toHaveBeenCalled(); expect(qs.quickSend.status).toBe("idle");
  });
  it("deletes retained ciphertext and discards a late encryption result", async () => {
    await start(); let finish!: (files: typeof FILE[]) => void;
    f.seedEncryptedFiles.mockImplementationOnce(() => new Promise(r => { finish = r; }));
    const pending = qs.offerFiles([new File(["secret"], "private.txt")]); qs.stopQuickSend(); finish([FILE]); await pending;
    const { removeCiphertext } = await import("$lib/transport/file/ciphertext-store");
    expect(removeCiphertext).toHaveBeenCalledWith(HASH); expect(qs.quickSend.offered).toEqual([]);
  });
});
