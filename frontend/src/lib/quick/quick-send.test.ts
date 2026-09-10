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
  left: string[] = [];
  joinRoom(code: string) {
    this.joined.push(code);
  }
  leaveRoom(code: string) {
    this.left.push(code);
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
  seeded: string[] = [];
  async seedFiles(files: File[]) {
    for (const f of files) this.seeded.push(f.name);
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
    await qs.startQuickSend("7qk3-m9ab-2c");
    expect(transport.joined).toEqual(["7QK3M9AB2C"]);
    expect(qs.quickSend.status).toBe("ready");
  });

  it("refuses a link that is not a quick code", async () => {
    const qs = await load();
    // A room code is 13 characters and means something else entirely; a page
    // that "helpfully" joined it would put a stranger in a real room.
    await qs.startQuickSend("6BMB3GST2JRJZ");
    expect(qs.quickSend.status).toBe("failed");
    expect(transport.joined).toEqual([]);
  });

  it("mints a code when there is none to join", async () => {
    const qs = await load();
    await qs.startQuickSend();
    expect(qs.quickSend.code).toMatch(/^[0-9A-HJKMNP-TV-Z]{10}$/);
    expect(qs.quickSend.isHost).toBe(true);
  });

  it("ignores a peer the relay has not placed in the code", async () => {
    const qs = await load();
    await qs.startQuickSend("7QK3M9AB2C");

    transport.emit("connect", "stranger");
    transport.emit("message", "stranger", frame(OFFER));

    // No inventory announce, and nothing offered to the user.
    expect(files.connected).toEqual([]);
    expect(files.signalled).toEqual([]);
    expect(qs.quickSend.incoming).toEqual([]);
  });

  it("wires a room peer and surfaces what it offers", async () => {
    const qs = await load();
    await qs.startQuickSend("7QK3M9AB2C");

    transport.roomPeers.add("friend");
    transport.emit("roomPeers", "7QK3M9AB2C", ["friend"]);
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
    await qs.startQuickSend("7QK3M9AB2C");

    transport.roomPeers.add("friend");
    transport.emit("roomPeers", "7QK3M9AB2C", ["friend"]);
    transport.emit("connect", "friend");
    transport.emit("roomPeers", "7QK3M9AB2C", ["friend"]);

    expect(files.connected).toEqual(["friend"]);
    expect(qs.quickSend.peers).toBe(1);
  });

  it("does not offer us back our own file", async () => {
    const qs = await load();
    await qs.startQuickSend("7QK3M9AB2C");
    await qs.offerFiles([new File(["x"], "mine.txt", { type: "text/plain" })]);
    expect(qs.quickSend.offered.map((f) => f.filename)).toEqual(["mine.txt"]);

    transport.roomPeers.add("friend");
    transport.emit("roomPeers", "7QK3M9AB2C", ["friend"]);
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
    await qs.startQuickSend("7QK3M9AB2C");
    transport.roomPeers.add("friend");
    transport.emit("roomPeers", "7QK3M9AB2C", ["friend"]);
    transport.emit("message", "friend", frame(OFFER));

    expect(files.downloads).toEqual([]);
    qs.acceptFile("never-offered");
    expect(files.downloads).toEqual([]);
    qs.acceptFile("abc");
    expect(files.downloads).toEqual(["abc"]);
  });

  it("serves on a file it finished, so the swarm has two sources", async () => {
    const qs = await load();
    await qs.startQuickSend("7QK3M9AB2C");
    transport.roomPeers.add("friend");
    transport.emit("roomPeers", "7QK3M9AB2C", ["friend"]);
    transport.emit("message", "friend", frame(OFFER));
    qs.acceptFile("abc");

    files.emit("downloaded", "abc", new Blob(["bytes"]));
    await Promise.resolve();

    // seedFiles announces to every wired peer, which is what makes the next
    // person's download have somewhere else to come from.
    expect(files.seeded).toEqual(["holiday.mp4"]);
    // And it is served locally from here on, exactly like our own offer.
    expect(await files.lookup?.("abc")).toBeInstanceOf(File);
  });

  it("does not serve on a file nobody offered us", async () => {
    const qs = await load();
    await qs.startQuickSend("7QK3M9AB2C");
    // A "downloaded" for a hash that was never in `incoming` has no
    // descriptor to name it, and re-announcing something unnamed would put a
    // file with a wrong name in front of the next person.
    files.emit("downloaded", "not-ours", new Blob(["bytes"]));
    await Promise.resolve();
    expect(files.seeded).toEqual([]);
  });

  it("does not upload for a browser asking sites to save data", async () => {
    const qs = await load();
    vi.stubGlobal("navigator", { connection: { saveData: true } });
    try {
      await qs.startQuickSend("7QK3M9AB2C");
      transport.roomPeers.add("friend");
      transport.emit("roomPeers", "7QK3M9AB2C", ["friend"]);
      transport.emit("message", "friend", frame(OFFER));
      files.emit("downloaded", "abc", new Blob(["bytes"]));
      await Promise.resolve();
      expect(files.seeded).toEqual([]);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a one-time link neither shares on nor stays open", async () => {
    const qs = await load();
    await qs.startQuickSend("7QK3M9AB2C");
    qs.setQuickSendMode("once");
    await qs.offerFiles([new File(["x"], "secret.pdf")]);
    files.seeded.length = 0;

    transport.roomPeers.add("friend");
    transport.emit("roomPeers", "7QK3M9AB2C", ["friend"]);
    // Every peer is told what the link is for as it is wired.
    const told = transport.sent
      .map((s) => JSON.parse(new TextDecoder().decode(s.data)))
      .filter((m) => m.type === "__qs_mode");
    expect(told.at(-1)).toEqual({ type: "__qs_mode", mode: "once" });

    // The receiver says it has the whole file, and the link shuts.
    transport.emit(
      "message",
      "friend",
      frame({ type: "__qs_ack", infoHash: "hash0" })
    );
    expect(qs.quickSend.status).toBe("closed");
    expect(qs.quickSend.closed).toBe(true);
    expect(transport.left).toEqual(["7QK3M9AB2C"]);
    expect(qs.quickSend.peers).toBe(0);
  });

  it("ignores an ack for a file it never offered", async () => {
    const qs = await load();
    await qs.startQuickSend("7QK3M9AB2C");
    qs.setQuickSendMode("once");
    transport.roomPeers.add("friend");
    transport.emit("roomPeers", "7QK3M9AB2C", ["friend"]);
    transport.emit(
      "message",
      "friend",
      frame({ type: "__qs_ack", infoHash: "someone-elses" })
    );
    expect(qs.quickSend.status).toBe("ready");
    expect(transport.left).toEqual([]);
  });

  it("a receiver on a one-time link does not share it on", async () => {
    const qs = await load();
    await qs.startQuickSend("7QK3M9AB2C");
    transport.roomPeers.add("friend");
    transport.emit("roomPeers", "7QK3M9AB2C", ["friend"]);
    transport.emit("message", "friend", frame(OFFER));
    transport.emit(
      "message",
      "friend",
      frame({ type: "__qs_mode", mode: "once" })
    );
    qs.acceptFile("abc");

    files.emit("downloaded", "abc", new Blob(["bytes"]));
    await Promise.resolve();

    expect(files.seeded).toEqual([]);
    // It still tells the sender, which is what closes the link.
    const acks = transport.sent
      .map((s) => JSON.parse(new TextDecoder().decode(s.data)))
      .filter((m) => m.type === "__qs_ack");
    expect(acks).toEqual([{ type: "__qs_ack", infoHash: "abc" }]);
  });

  it("cannot be talked out of one-time by a later peer", async () => {
    // Everyone in the room holds the link already, so a peer could otherwise
    // announce "multi" and talk the others into serving on a file whose
    // sender asked for one delivery.
    const qs = await load();
    await qs.startQuickSend("7QK3M9AB2C");
    transport.roomPeers.add("friend");
    transport.emit("roomPeers", "7QK3M9AB2C", ["friend"]);
    transport.emit("message", "friend", frame(OFFER));
    transport.emit("message", "friend", frame({ type: "__qs_mode", mode: "once" }));
    transport.emit("message", "friend", frame({ type: "__qs_mode", mode: "multi" }));

    files.emit("downloaded", "abc", new Blob(["bytes"]));
    await Promise.resolve();
    expect(files.seeded).toEqual([]);
  });

  it("survives a frame that is not ours", async () => {
    const qs = await load();
    await qs.startQuickSend("7QK3M9AB2C");
    transport.roomPeers.add("friend");
    transport.emit("roomPeers", "7QK3M9AB2C", ["friend"]);

    expect(() => {
      transport.emit("message", "friend", new TextEncoder().encode("{oops"));
      transport.emit("message", "friend", frame({ type: "__chat", body: "hi" }));
    }).not.toThrow();
    expect(qs.quickSend.incoming).toEqual([]);
  });

  it("leaves nothing behind when the page goes away", async () => {
    const qs = await load();
    await qs.startQuickSend("7QK3M9AB2C");
    transport.roomPeers.add("friend");
    transport.emit("roomPeers", "7QK3M9AB2C", ["friend"]);
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

    await qs.startQuickSend("7QK3M9AB2C");
    expect(qs.quickSend.status).toBe("failed");
    expect(transport.joined).toEqual([]);
    vi.doUnmock("$lib/runtime-config");
  });
});
