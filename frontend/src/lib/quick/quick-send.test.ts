import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The gate is the thing worth testing here: a peer only counts once the RELAY
 * has placed it in the code. Wiring a peer that merely dialled us hands a
 * stranger the list of what this tab is offering, and believing its file
 * offer puts a file nobody sent in front of the user.
 */

class FakeTransport {
  handlers = new Map<string, Function[]>();
  roomPeers = new Set<string>();
  joined: string[] = [];
  sent: { peerId: string; data: Uint8Array }[] = [];
  disconnected = false;

  on(event: string, handler: Function) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  emit(event: string, ...args: unknown[]) {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
  async connect() {}
  joinRoom(code: string) {
    this.joined.push(code);
  }
  isRoomPeer(_room: string, peerId: string) {
    return this.roomPeers.has(peerId);
  }
  peersInRoom() {
    return [...this.roomPeers];
  }
  selfId() {
    return "self";
  }
  async send(peerId: string, data: Uint8Array) {
    this.sent.push({ peerId, data });
    return true;
  }
  async disconnect() {
    this.disconnected = true;
  }
}

class FakeFiles {
  handlers = new Map<string, Function[]>();
  connected: string[] = [];
  signalled: string[] = [];
  downloads: string[] = [];
  destroyed = false;
  lookup: ((infoHash: string) => Promise<File | null>) | null = null;

  on(event: string, handler: Function) {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
  }
  emit(event: string, ...args: unknown[]) {
    for (const h of this.handlers.get(event) ?? []) h(...args);
  }
  setLocalFileLookup(fn: (infoHash: string) => Promise<File | null>) {
    this.lookup = fn;
  }
  async seedFiles(files: File[]) {
    return files.map((f, i) => ({
      infoHash: `hash${i}`,
      filename: f.name,
      mimeType: f.type,
      size: f.size,
    }));
  }
  handleSignal(peerId: string) {
    this.signalled.push(peerId);
  }
  ensureDownload(file: { infoHash: string }) {
    this.downloads.push(file.infoHash);
  }
  onPeerConnect(peerId: string) {
    this.connected.push(peerId);
  }
  onPeerDisconnect(peerId: string) {
    this.connected = this.connected.filter((p) => p !== peerId);
  }
  destroy() {
    this.destroyed = true;
  }
}

let transport: FakeTransport;
let files: FakeFiles;

vi.mock("$lib/transport/libp2p/transport", () => ({
  LibP2PTransport: class {
    constructor() {
      return transport as unknown as object;
    }
  },
}));
vi.mock("$lib/transport/file/webtorrent", () => ({
  WebTorrentFileTransport: class {
    constructor() {
      return files as unknown as object;
    }
  },
}));
vi.mock("$lib/transport/ice-server-list", () => ({
  refreshTurnCredentials: () => Promise.resolve(),
}));
vi.mock("$lib/runtime-config", () => ({ isConfigured: () => true }));

const OFFER = {
  type: "__file_signal",
  payload: {
    kind: "file-seeder",
    file: {
      infoHash: "abc",
      filename: "holiday.mp4",
      mimeType: "video/mp4",
      size: 42,
    },
  },
};

function frame(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

async function load() {
  vi.resetModules();
  transport = new FakeTransport();
  files = new FakeFiles();
  return import("./quick-send.svelte");
}

describe("quick send", () => {
  beforeEach(() => {
    transport = new FakeTransport();
    files = new FakeFiles();
  });

  it("joins the code it is given, normalized", async () => {
    const qs = await load();
    await qs.startQuickSend("abcd-efgh-jkmn-p");
    expect(transport.joined).toEqual(["ABCDEFGHJKMNP"]);
    expect(qs.quickSend.status).toBe("ready");
  });

  it("mints a code when there is none to join", async () => {
    const qs = await load();
    await qs.startQuickSend();
    expect(qs.quickSend.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{13}$/);
    expect(qs.quickSend.isHost).toBe(true);
  });

  it("ignores a peer the relay has not placed in the code", async () => {
    const qs = await load();
    await qs.startQuickSend("ABCDEFGHJKMNP");

    transport.emit("connect", "stranger");
    transport.emit("message", "stranger", frame(OFFER));

    // No inventory announce, and nothing offered to the user.
    expect(files.connected).toEqual([]);
    expect(files.signalled).toEqual([]);
    expect(qs.quickSend.incoming).toEqual([]);
  });

  it("wires a room peer and surfaces what it offers", async () => {
    const qs = await load();
    await qs.startQuickSend("ABCDEFGHJKMNP");

    transport.roomPeers.add("friend");
    transport.emit("roomPeers", "ABCDEFGHJKMNP", ["friend"]);
    transport.emit("message", "friend", frame(OFFER));

    expect(files.connected).toEqual(["friend"]);
    expect(qs.quickSend.peers).toBe(1);
    expect(qs.quickSend.incoming.map((f) => f.filename)).toEqual([
      "holiday.mp4",
    ]);
    expect(files.signalled).toEqual(["friend"]);
  });

  it("wires a room peer only once, however often the relay lists it", async () => {
    const qs = await load();
    await qs.startQuickSend("ABCDEFGHJKMNP");

    transport.roomPeers.add("friend");
    transport.emit("roomPeers", "ABCDEFGHJKMNP", ["friend"]);
    transport.emit("connect", "friend");
    transport.emit("roomPeers", "ABCDEFGHJKMNP", ["friend"]);

    expect(files.connected).toEqual(["friend"]);
    expect(qs.quickSend.peers).toBe(1);
  });

  it("does not offer us back our own file", async () => {
    const qs = await load();
    await qs.startQuickSend("ABCDEFGHJKMNP");
    await qs.offerFiles([new File(["x"], "mine.txt", { type: "text/plain" })]);
    expect(qs.quickSend.offered.map((f) => f.filename)).toEqual(["mine.txt"]);

    transport.roomPeers.add("friend");
    transport.emit("roomPeers", "ABCDEFGHJKMNP", ["friend"]);
    transport.emit(
      "message",
      "friend",
      frame({
        type: "__file_signal",
        payload: {
          kind: "file-seeder",
          file: { ...OFFER.payload.file, infoHash: "hash0" },
        },
      })
    );

    expect(qs.quickSend.incoming).toEqual([]);
  });

  it("downloads only on request, and only what was offered", async () => {
    const qs = await load();
    await qs.startQuickSend("ABCDEFGHJKMNP");
    transport.roomPeers.add("friend");
    transport.emit("roomPeers", "ABCDEFGHJKMNP", ["friend"]);
    transport.emit("message", "friend", frame(OFFER));

    expect(files.downloads).toEqual([]);
    qs.acceptFile("never-offered");
    expect(files.downloads).toEqual([]);
    qs.acceptFile("abc");
    expect(files.downloads).toEqual(["abc"]);
  });

  it("survives a frame that is not ours", async () => {
    const qs = await load();
    await qs.startQuickSend("ABCDEFGHJKMNP");
    transport.roomPeers.add("friend");
    transport.emit("roomPeers", "ABCDEFGHJKMNP", ["friend"]);

    expect(() => {
      transport.emit("message", "friend", new TextEncoder().encode("{oops"));
      transport.emit("message", "friend", frame({ type: "__chat", body: "hi" }));
    }).not.toThrow();
    expect(qs.quickSend.incoming).toEqual([]);
  });

  it("leaves nothing behind when the page goes away", async () => {
    const qs = await load();
    await qs.startQuickSend("ABCDEFGHJKMNP");
    transport.roomPeers.add("friend");
    transport.emit("roomPeers", "ABCDEFGHJKMNP", ["friend"]);
    await qs.offerFiles([new File(["x"], "mine.txt")]);

    qs.stopQuickSend();

    expect(files.destroyed).toBe(true);
    expect(transport.disconnected).toBe(true);
    expect(qs.quickSend.code).toBe("");
    expect(qs.quickSend.offered).toEqual([]);
    expect(qs.quickSend.status).toBe("idle");
  });

  it("reports an instance with no relay instead of dialling nothing", async () => {
    vi.resetModules();
    vi.doMock("$lib/runtime-config", () => ({ isConfigured: () => false }));
    transport = new FakeTransport();
    files = new FakeFiles();
    const qs = await import("./quick-send.svelte");

    await qs.startQuickSend("ABCDEFGHJKMNP");
    expect(qs.quickSend.status).toBe("failed");
    expect(transport.joined).toEqual([]);
    vi.doUnmock("$lib/runtime-config");
  });
});
