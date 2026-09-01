import { describe, it, expect, afterEach } from "vitest";
import { installPcCensus, pcCensus, uninstallPcCensus } from "./pc-census";

/** The smallest thing that can stand in for the global: jsdom has none. */
class FakePc {
  connectionState = "new";
  closed = false;
  #listeners: Array<() => void> = [];
  constructor(public config?: unknown) {}
  addEventListener(_type: string, fn: () => void): void {
    this.#listeners.push(fn);
  }
  close(): void {
    this.closed = true;
  }
  /** Drive the path where the BROWSER closes a connection we did not. */
  browserClosed(): void {
    this.connectionState = "closed";
    for (const fn of this.#listeners) fn();
  }
}

type G = { RTCPeerConnection?: unknown };

function withFakeGlobal(): void {
  (globalThis as G).RTCPeerConnection = FakePc;
  installPcCensus();
}

afterEach(() => {
  uninstallPcCensus();
  delete (globalThis as G).RTCPeerConnection;
});

describe("pc census", () => {
  it("counts what is open, not what was made", () => {
    withFakeGlobal();
    const Ctor = (globalThis as G).RTCPeerConnection as new () => {
      close(): void;
    };

    const a = new Ctor();
    const b = new Ctor();
    expect(pcCensus()).toMatchObject({ live: 2, created: 2, peak: 2 });

    a.close();
    // The leak this exists to catch: `created` and `peak` remember the two,
    // `live` reports the one still holding a slot in the browser's budget.
    expect(pcCensus()).toMatchObject({ live: 1, created: 2, peak: 2 });
    b.close();
    expect(pcCensus().live).toBe(0);
  });

  it("decrements once, however many times close is called", () => {
    withFakeGlobal();
    const Ctor = (globalThis as G).RTCPeerConnection as new () => {
      close(): void;
    };
    const pc = new Ctor();
    pc.close();
    pc.close();
    pc.close();
    // A double decrement would read as negative live connections, which is
    // worse than no gauge at all - it hides a real leak.
    expect(pcCensus().live).toBe(0);
  });

  it("notices a connection the browser closed on its own", () => {
    withFakeGlobal();
    const Ctor = (globalThis as G).RTCPeerConnection as new () => FakePc;
    const pc = new Ctor();
    expect(pcCensus().live).toBe(1);
    pc.browserClosed();
    expect(pcCensus().live).toBe(0);
  });

  it("still constructs a working connection, and stays an instanceof", () => {
    withFakeGlobal();
    const Ctor = (globalThis as G).RTCPeerConnection as new (
      c?: unknown
    ) => FakePc;
    const pc = new Ctor({ iceServers: [] });
    // The wrapper must be invisible to every consumer: libp2p, webtorrent and
    // mediasoup-client all hold these and one behavioural difference would be
    // a telemetry feature breaking the app it measures.
    expect(pc).toBeInstanceOf(FakePc);
    expect(pc.config).toEqual({ iceServers: [] });
    pc.close();
    expect(pc.closed).toBe(true);
  });

  it("is a no-op where there is no WebRTC at all", () => {
    delete (globalThis as G).RTCPeerConnection;
    installPcCensus();
    expect(pcCensus().installed).toBe(false);
  });
});
