import { afterEach, beforeEach, expect, it, vi } from "vitest";

/**
 * The node keeps the relay it starts with for the whole session. A launch
 * that starts from the saved configuration reads the served one behind the
 * app (runtime-config.ts), and connect() started the node without waiting
 * for that read: a relay that had moved since was dialled where it used to
 * be, and while the old one was up the session stayed there.
 */

/** Stands in for the network classes so the module loads in node: every method is a no-op. */
function inert() {
  return class {
    constructor() {
      return new Proxy(this, {
        get: (target, key) => (key in target || key === "then" ? Reflect.get(target, key) : () => {}),
      });
    }
  };
}

const MOCKED = [
  "$lib/runtime-config",
  "$lib/transport/node-lock",
  "$lib/transport/libp2p/transport",
  "$lib/transport/libp2p/voice",
  "$lib/transport/mediasoup",
  "$lib/transport/file/webtorrent",
];

beforeEach(() => vi.resetModules());
afterEach(() => {
  for (const path of MOCKED) vi.doUnmock(path);
});

// The whole transport graph loads here, which takes a while on a busy run.
it("starts the node once the configuration being read has landed", async () => {
  const nodeConnect = vi.fn(async () => {});
  class Transport extends inert() {
    connect = nodeConnect;
  }
  let land!: () => void;
  const landed = new Promise<void>((resolve) => (land = resolve));
  const configSettled = vi.fn(() => landed);
  vi.doMock("$lib/runtime-config", async (original) => ({
    ...(await original<Record<string, unknown>>()),
    configSettled,
  }));
  vi.doMock("$lib/transport/node-lock", async (original) => ({
    ...(await original<Record<string, unknown>>()),
    acquireNodeLock: async () => {},
  }));
  vi.doMock("$lib/transport/libp2p/transport", () => ({ LibP2PTransport: Transport }));
  vi.doMock("$lib/transport/libp2p/voice", () => ({ LibP2PVoice: inert() }));
  vi.doMock("$lib/transport/mediasoup", () => ({ MediasoupVideo: inert() }));
  vi.doMock("$lib/transport/file/webtorrent", () => ({ WebTorrentFileTransport: inert() }));

  const { connect } = await import("$lib/transport/transport.svelte");
  const connecting = connect().catch(() => {});
  await vi.waitFor(() => expect(configSettled).toHaveBeenCalledWith(1000));
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(nodeConnect).not.toHaveBeenCalled();
  land();
  await connecting;
  expect(nodeConnect).toHaveBeenCalledOnce();
}, 60_000);
