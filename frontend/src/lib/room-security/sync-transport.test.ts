import { describe, expect, it, vi } from "vitest";

/** The link underneath: which connections there are, and which channels were left. */
vi.mock("$lib/transport/libp2p/transport", () => ({
  LibP2PTransport: class {
    open: any[] = [];
    on: any = null;
    dialled: string[] = [];
    failDial = false;
    openConnections() { return this.open; }
    secureRoomConnection() { return this.on; }
    closeSecureRoom() { const was = this.on; this.on = null; return was ? [was] : []; }
    async roomConnection() { return "plain dial"; }
    async dialAnother(_n: unknown, _p: string, via: string) { this.dialled.push(via); if (this.failDial) throw new Error("no route"); return "new connection"; }
  },
}));

import { isLivenessFrame, SecureSyncTransport } from "./sync-transport";
import { newRoomSecret } from "./keys";

const bytes = (s: string) => new TextEncoder().encode(s);

describe("which frames the pairing transport leaves on the direct stream", () => {
  it("is the link's own pings and pongs", () => {
    expect(isLivenessFrame(bytes(JSON.stringify({ type: "__ping", n: 7 })))).toBe(true);
    expect(isLivenessFrame(bytes(JSON.stringify({ type: "__pong", n: 7, w: 1_794_000_000_000 })))).toBe(true);
  });

  it("is never a sync frame, however it starts", () => {
    expect(isLivenessFrame(bytes(JSON.stringify({ type: "sync_export_ack", v: 2, payload: { seq: 1 } })))).toBe(false);
    expect(isLivenessFrame(bytes(JSON.stringify({ type: "__ping", n: 7, data: "x".repeat(80) })))).toBe(false);
    expect(isLivenessFrame(bytes('{"type":"sync_export_data"}'))).toBe(false);
  });
});

describe("which connection a sync goes over", () => {
  const circuit = { name: "circuit", direct: false };
  const direct = { name: "direct", direct: true };
  const sync = (open: any[], on: any = null) => {
    const t = new SecureSyncTransport(newRoomSecret()) as any;
    t.open = open;
    t.on = on;
    return t;
  };
  const pick = (t: any) => t.roomConnection({}, "peer", new AbortController().signal);

  it("is the direct one when there is one", async () => {
    expect(await pick(sync([circuit, direct]))).toBe(direct);
    expect(await pick(sync([circuit]))).toBe(circuit);
    expect(await pick(sync([]))).toBe("plain dial");
  });

  it("is the other kind after one went quiet, and a new one when all have", async () => {
    const other = { name: "another direct", direct: true };
    const t = sync([direct, other, circuit], direct);
    t.reopen("peer");
    expect(await pick(t)).toBe(circuit);
    t.on = circuit;
    t.reopen("peer");
    expect(await pick(t)).toBe(other);
    t.on = other;
    t.reopen("peer");
    expect(await pick(t)).toBe("new connection");
    // A direct one was the last to go quiet.
    expect(t.dialled).toEqual(["relay"]);
  });

  it("is not the one whose channel never opened, next time", async () => {
    const t = sync([direct, circuit]);
    expect(await pick(t)).toBe(direct);
    t.reopen("peer");
    expect(await pick(t)).toBe(circuit);
  });

  it("goes back to one that went quiet when no new one can be had", async () => {
    const t = sync([circuit, direct], direct);
    t.reopen("peer");
    t.on = circuit;
    t.reopen("peer");
    t.failDial = true;
    expect(await pick(t)).toBe(direct);
    expect(t.dialled).toEqual(["direct", "relay"]);
  });

  it("moves a channel to the direct one only when that is an improvement", () => {
    const moved = sync([circuit, direct], circuit);
    moved.preferDirect("peer");
    expect(moved.on).toBeNull();
    const already = sync([circuit, direct], direct);
    already.preferDirect("peer");
    expect(already.on).toBe(direct);
    const none = sync([circuit], circuit);
    none.preferDirect("peer");
    expect(none.on).toBe(circuit);
  });
});
