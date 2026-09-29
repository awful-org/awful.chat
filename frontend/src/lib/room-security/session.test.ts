import { describe, expect, it } from "vitest";
import { deriveRoomKeys, newRoomSecret } from "./keys";
import { MembershipSession } from "./session";
import { ReplayWindow } from "./replay";
import { MembershipRegistry } from "./membership-registry";

function pair(now?: () => number) {
  const keys = deriveRoomKeys(newRoomSecret());
  return {
    keys,
    a: new MembershipSession(keys, "alice", "bob", "initiator", now),
    b: new MembershipSession(keys, "bob", "alice", "responder", now),
  };
}

describe("connection-owned room membership", () => {
  it("requires mutual proof and clears authorization on disconnect", () => {
    const { a, b } = pair();
    const challenge = b.receive(a.start());
    expect(a.verified).toBe(false);
    expect(b.verified).toBe(false);
    const finish = a.receive(challenge);
    expect(a.verified).toBe(true);
    expect(b.verified).toBe(false);
    expect(b.receive(finish)).toBeNull();
    expect(b.verified).toBe(true);
    a.close(); b.close();
    expect(a.verified).toBe(false);
    expect(b.verified).toBe(false);
    expect(() => a.receive(challenge)).toThrow();
  });

  it("rejects a proof from an old connection to the same peer", () => {
    const { keys, a, b } = pair();
    const recorded = b.receive(a.start());
    const replacement = new MembershipSession(keys, "alice", "bob", "initiator");
    replacement.start();
    expect(() => replacement.receive(recorded)).toThrow();
    expect(replacement.verified).toBe(false);
  });

  it("rejects relay-injected peers with a different transport identity", () => {
    const { keys, a } = pair();
    const wrongIdentity = new MembershipSession(keys, "mallory", "alice", "responder");
    const challenge = wrongIdentity.receive(a.start());
    expect(() => a.receive(challenge)).toThrow();
    expect(a.verified).toBe(false);
  });

  it("expires a pending handshake even if a valid reply eventually arrives", () => {
    let time = 0;
    const { a, b } = pair(() => time);
    const challenge = b.receive(a.start());
    time = 10_000;
    expect(() => a.receive(challenge)).toThrow();
    expect(a.verified).toBe(false);
  });

  it("makes malformed/out-of-order authentication failures terminal", () => {
    const { a, b } = pair();
    const hello = a.start();
    expect(() => b.receive({ ...hello, challenge: "invalid" })).toThrow();
    expect(() => b.receive(hello)).toThrow();
    expect(b.verified).toBe(false);
  });
});

describe("authenticated sequence replay window", () => {
  it("allows bounded reordering but rejects duplicates and old sequences", () => {
    const w = new ReplayWindow();
    expect(w.accept(10)).toBe(true);
    expect(w.accept(8)).toBe(true);
    expect(w.accept(8)).toBe(false);
    expect(w.accept(10)).toBe(false);
    expect(w.accept(73)).toBe(true);
    expect(w.accept(10)).toBe(false);
    expect(w.accept(9)).toBe(false);
    expect(w.accept(72)).toBe(true);
  });

  it("rejects invalid numbers without poisoning the window", () => {
    const w = new ReplayWindow();
    for (const n of [-1, NaN, Infinity, 1.5, Number.MAX_SAFE_INTEGER + 1]) expect(w.accept(n)).toBe(false);
    expect(w.accept(0)).toBe(true);
    expect(w.accept(Number.MAX_SAFE_INTEGER)).toBe(true);
    expect(w.accept(0)).toBe(false);
  });
});

describe("membership admission registry", () => {
  it("bounds pending work and releases timed-out slots", () => {
    let time = 0;
    const registry = new MembershipRegistry(() => time, 2, 1);
    const keys = deriveRoomKeys(newRoomSecret());
    const a = {};
    const first = registry.begin(a, keys, "alice", "bob", "initiator");
    expect(() => registry.begin(a, deriveRoomKeys(newRoomSecret()), "alice", "bob", "initiator")).toThrow();
    registry.begin({}, keys, "alice", "carol", "initiator");
    expect(() => registry.begin({}, keys, "alice", "dan", "initiator")).toThrow();
    time = 10_000;
    registry.begin({}, keys, "alice", "dan", "initiator");
    expect(() => first.start()).toThrow();
    expect(registry.verified(a, keys.discoveryId)).toBe(false);
  });

  it("does not transfer authorization to a replacement connection or another room", () => {
    const registry = new MembershipRegistry();
    const keys = deriveRoomKeys(newRoomSecret());
    const connection = {};
    const local = registry.begin(connection, keys, "alice", "bob", "initiator");
    const remote = new MembershipSession(keys, "bob", "alice", "responder");
    remote.receive(local.receive(remote.receive(local.start())));
    expect(registry.verified(connection, keys.discoveryId)).toBe(true);
    expect(registry.verified({}, keys.discoveryId)).toBe(false);
    expect(registry.verified(connection, deriveRoomKeys(newRoomSecret()).discoveryId)).toBe(false);
    registry.disconnect(connection);
    expect(registry.verified(connection, keys.discoveryId)).toBe(false);
    expect(local.verified).toBe(false);
  });
});
