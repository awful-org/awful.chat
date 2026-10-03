import { afterEach, expect, it, vi } from "vitest";
vi.mock("@libp2p/webrtc", () => ({ webRTC: () => ({}) }));
vi.mock("@libp2p/peer-id", async (original) => ({
  ...await original<typeof import("@libp2p/peer-id")>(),
  peerIdFromString: (peer: string) => ({ toString: () => peer }),
}));
import { LibP2PTransport } from "./transport";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A rendezvous stream the test can answer on, or close. */
class FakeStream extends EventTarget {
  status = "open";
  send() { return true; }
  abort() { this.close(); }
  close() {
    if (this.status !== "open") return;
    this.status = "closed";
    this.dispatchEvent(new Event("close"));
  }
  answer(msg: unknown) {
    const body = new TextEncoder().encode(JSON.stringify(msg));
    const frame = new Uint8Array(4 + body.length);
    new DataView(frame.buffer).setUint32(0, body.length);
    frame.set(body, 4);
    this.dispatchEvent(Object.assign(new Event("message"), { data: frame }));
  }
}

function transport() {
  vi.useFakeTimers();
  vi.spyOn(Math, "random").mockReturnValue(0); // no jitter: exact delays
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const t = new LibP2PTransport();
  const internal = t as any;
  const dialProtocol = vi.fn(async (): Promise<FakeStream> => { throw new Error("relay down"); });
  internal.node = { dialProtocol, peerId: { toString: () => "me" } };
  internal.relayPeerId = "relay";
  return { internal, dialProtocol };
}

it("backs off while the relay is down, instead of re-dialling it every two seconds", async () => {
  const { internal, dialProtocol } = transport();
  await internal.startRendezvous();
  await vi.advanceTimersByTimeAsync(60_000);
  // 2, 4, 8, 16 and 32 s apart: five dials in the first minute, not thirty-one.
  expect(dialProtocol).toHaveBeenCalledTimes(5);
  await vi.advanceTimersByTimeAsync(10 * 60_000);
  // And never further apart than a minute.
  expect(dialProtocol.mock.calls.length).toBeGreaterThanOrEqual(5 + 9);
  expect(dialProtocol.mock.calls.length).toBeLessThanOrEqual(5 + 11);
});

it("starts over from two seconds once the relay answers on a stream", async () => {
  const { internal, dialProtocol } = transport();
  await internal.startRendezvous();
  await vi.advanceTimersByTimeAsync(60_000); // backed off to 32 s and growing
  const stream = new FakeStream();
  dialProtocol.mockResolvedValue(stream);
  await vi.advanceTimersByTimeAsync(2_000);
  expect(internal.rendezvousStream).toBe(stream);
  stream.answer({ type: "PONG" });
  stream.close();
  const calls = dialProtocol.mock.calls.length;
  dialProtocol.mockRejectedValue(new Error("relay down"));
  await vi.advanceTimersByTimeAsync(1_999);
  expect(dialProtocol).toHaveBeenCalledTimes(calls);
  await vi.advanceTimersByTimeAsync(1);
  expect(dialProtocol).toHaveBeenCalledTimes(calls + 1);
});

it("keeps backing off when the relay closes each stream as soon as it opens", async () => {
  const { internal, dialProtocol } = transport();
  // Reset the moment it opens - a relay at its per-peer stream cap does this.
  dialProtocol.mockImplementation(async () => {
    const stream = new FakeStream();
    setTimeout(() => stream.close(), 0);
    return stream;
  });
  await internal.startRendezvous();
  await vi.advanceTimersByTimeAsync(60_000);
  expect(dialProtocol).toHaveBeenCalledTimes(5);
});

it("waits out the radio being down without dialling", async () => {
  const { internal, dialProtocol } = transport();
  await internal.startRendezvous();
  internal.offline = true;
  await vi.advanceTimersByTimeAsync(5 * 60_000);
  expect(dialProtocol).toHaveBeenCalledTimes(1);
});

it("holds one retry at a time, and none after a disconnect", async () => {
  const { internal, dialProtocol } = transport();
  internal.scheduleRendezvousRetry();
  internal.scheduleRendezvousRetry(); // the same drop, reported twice
  await vi.advanceTimersByTimeAsync(2_000);
  expect(dialProtocol).toHaveBeenCalledTimes(1);
  internal.stopRendezvousRetry();
  internal.intentionalDisconnect = true;
  await vi.advanceTimersByTimeAsync(60_000);
  expect(dialProtocol).toHaveBeenCalledTimes(1);
});
