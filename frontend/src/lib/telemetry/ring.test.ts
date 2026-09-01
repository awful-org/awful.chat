import { describe, it, expect } from "vitest";
import { ev } from "./event";
import { DiagRing, RING_CAPACITY } from "./ring";

describe("DiagRing", () => {
  it("keeps the newest events and counts the evicted ones", () => {
    const ring = new DiagRing(4, {});
    for (let i = 0; i < 10; i++) ring.push(ev("session.config"), i, i * 1000);
    const snap = ring.snapshot();
    expect(snap.events).toHaveLength(4);
    expect(snap.dropped).toBe(6);
    expect(snap.events.map((e) => e.seq)).toEqual([7, 8, 9, 10]);
  });

  it("returns events oldest first before it has wrapped", () => {
    const ring = new DiagRing(8, {});
    ring.push(ev("session.start"), 0, 0);
    ring.push(ev("session.end"), 5, 1000);
    expect(ring.snapshot().events.map((e) => e.kind)).toEqual([
      "session.start",
      "session.end",
    ]);
    expect(ring.size).toBe(2);
  });

  it("numbers events from 1 and rounds t to an integer", () => {
    const ring = new DiagRing(4, {});
    ring.push(ev("session.start"), 12.7, 0);
    const [e] = ring.snapshot().events;
    expect(e.seq).toBe(1);
    expect(e.t).toBe(13);
  });

  it("suppresses past the per-kind budget inside one window", () => {
    const ring = new DiagRing(1024, {});
    let accepted = 0;
    // DEFAULT_BUDGET is 20 and `session.config` is an "info" kind.
    for (let i = 0; i < 25; i++) {
      if (ring.push(ev("session.config"), i, 500)) accepted++;
    }
    expect(accepted).toBe(20);
    expect(ring.snapshot().suppressed).toEqual({ "session.config": 5 });
  });

  it("gives an error kind the bigger budget", () => {
    const ring = new DiagRing(1024, {});
    let accepted = 0;
    for (let i = 0; i < 70; i++) {
      if (ring.push(ev("peer.dial.fail"), i, 500)) accepted++;
    }
    expect(accepted).toBe(60);
  });

  it("honours a per-kind override", () => {
    const ring = new DiagRing(1024, { "peer.rtt": 2 });
    let accepted = 0;
    for (let i = 0; i < 5; i++) {
      if (ring.push(ev("peer.rtt"), i, 0)) accepted++;
    }
    expect(accepted).toBe(2);
  });

  it("opens a fresh window after a second", () => {
    const ring = new DiagRing(1024, { "peer.rtt": 1 });
    expect(ring.push(ev("peer.rtt"), 0, 0)).toBe(true);
    expect(ring.push(ev("peer.rtt"), 1, 500)).toBe(false);
    expect(ring.push(ev("peer.rtt"), 2, 1000)).toBe(true);
  });

  it("announces a gap with exactly one meta.suppressed in a later window", () => {
    const ring = new DiagRing(1024, { "peer.rtt": 1 });
    ring.push(ev("peer.rtt"), 0, 0);
    ring.push(ev("peer.rtt"), 1, 100); // suppressed
    ring.push(ev("peer.rtt"), 2, 200); // suppressed
    ring.push(ev("session.config"), 3, 2000); // later window: announces
    ring.push(ev("session.config"), 4, 2001); // must NOT announce again

    const kinds = ring.snapshot().events.map((e) => e.kind);
    expect(kinds).toEqual([
      "peer.rtt",
      "meta.suppressed",
      "session.config",
      "session.config",
    ]);
    const meta = ring.snapshot().events[1];
    expect(meta.d).toEqual({ "peer.rtt": 2 });
  });

  it("does not announce a gap inside the window that produced it", () => {
    const ring = new DiagRing(1024, { "peer.rtt": 1 });
    ring.push(ev("peer.rtt"), 0, 0);
    ring.push(ev("peer.rtt"), 1, 100); // suppressed
    ring.push(ev("session.config"), 2, 200); // same window
    expect(ring.snapshot().events.map((e) => e.kind)).toEqual([
      "peer.rtt",
      "session.config",
    ]);
  });

  it("resets to an empty ring", () => {
    const ring = new DiagRing(4, {});
    ring.push(ev("session.start"), 0, 0);
    ring.reset();
    expect(ring.snapshot()).toEqual({
      events: [],
      dropped: 0,
      suppressed: {},
      nextSeq: 1,
    });
  });

  it("defaults to a capacity that covers a useful window", () => {
    expect(new DiagRing().capacity).toBe(RING_CAPACITY);
  });

  it("never accepts a zero or negative capacity", () => {
    expect(new DiagRing(0).capacity).toBe(1);
    expect(new DiagRing(-5).capacity).toBe(1);
  });
});
