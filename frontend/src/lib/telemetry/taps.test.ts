import { describe, it, expect, beforeEach } from "vitest";
import {
  counterEvents,
  diffCounters,
  flattenBags,
  statusEvent,
  transportEvent,
  videoEvent,
  voiceEvent,
} from "./taps";
import { beginSession, refs, resetRecorderForTest } from "./recorder";
import { KIND_SEV, type DiagKind } from "./schema";
import type { TransportStatus } from "../transport/types";

/** A human-facing banner string. It must never reach a bundle. */
const SENTINEL = "zzUserFacingBannerTextzz";

/** Every member of the `TransportStatus` union, in declaration order. */
const ALL_STATUSES: TransportStatus[] = [
  { type: "app-warning", message: SENTINEL },
  { type: "relay-connected", message: SENTINEL },
  { type: "relay-disconnected", message: SENTINEL },
  { type: "relay-dial-retry", message: SENTINEL },
  { type: "relay-dial-failed", message: SENTINEL },
  { type: "relay-reconnect-failed", message: SENTINEL },
  { type: "relay-reconnecting", message: SENTINEL },
  { type: "stream-open-failed", peerId: "12D3KooWAAA", message: SENTINEL },
  { type: "rendezvous-failed", message: SENTINEL },
  { type: "rendezvous-reconnecting", message: SENTINEL },
  { type: "reservation-timeout", message: SENTINEL },
  { type: "voice-dial-failed", peerId: "12D3KooWAAA", message: SENTINEL },
  { type: "voice-peer-left", peerId: "12D3KooWAAA", message: SENTINEL },
  { type: "peer-dial-failed", peerId: "12D3KooWAAA", message: SENTINEL },
  { type: "voice-connection-failed", peerId: "12D3KooWAAA", message: SENTINEL },
  {
    type: "voice-ice-connected",
    peerId: "12D3KooWAAA",
    relayed: true,
    message: SENTINEL,
  },
  { type: "voice-degraded", peerId: "12D3KooWAAA", message: SENTINEL },
];

describe("statusEvent", () => {
  it("covers all 17 TransportStatus variants", () => {
    // Nine of these are emitted today and read by nothing. If a variant is
    // added to the union and not to the table, `statusEvent` stops compiling -
    // this asserts the other direction, that the fixture is complete.
    expect(ALL_STATUSES).toHaveLength(17);
    const types = new Set(ALL_STATUSES.map((s) => s.type));
    expect(types.size).toBe(17);
  });

  it("maps each variant to its documented kind", () => {
    const expected: Record<string, DiagKind> = {
      "app-warning": "session.config",
      "relay-connected": "relay.dial.ok",
      "relay-disconnected": "relay.disconnect",
      "relay-dial-retry": "relay.dial.attempt",
      "relay-dial-failed": "relay.dial.fail",
      "relay-reconnecting": "relay.reconnect.schedule",
      "relay-reconnect-failed": "relay.reconnect.fail",
      "reservation-timeout": "relay.reservation.timeout",
      "rendezvous-failed": "rv.open.fail",
      "rendezvous-reconnecting": "rv.open",
      "stream-open-failed": "stream.open.fail",
      "peer-dial-failed": "peer.dial.fail",
      "voice-dial-failed": "voice.pc.new",
      "voice-peer-left": "voice.teardown",
      "voice-connection-failed": "voice.failed",
      "voice-ice-connected": "voice.ice.connected",
      "voice-degraded": "voice.degraded",
    };
    for (const status of ALL_STATUSES) {
      expect(statusEvent(status).kind).toBe(expected[status.type]);
    }
  });

  it("carries the full peerId for every peer-naming variant", () => {
    for (const status of ALL_STATUSES) {
      if (!("peerId" in status)) continue;
      expect(statusEvent(status).peer).toBe("12D3KooWAAA");
    }
  });

  it("escalates the two variants whose default severity is too low", () => {
    // `app-warning` is a real app problem and `rendezvous-reconnecting` means
    // the room membership channel is down, but their kinds are shared with
    // ordinary info events.
    expect(statusEvent({ type: "app-warning", message: SENTINEL }).sev).toBe("warn");
    expect(
      statusEvent({ type: "rendezvous-reconnecting", message: SENTINEL }).sev
    ).toBe("warn");
  });

  it("records a voice dial failure as an error even though its kind is info", () => {
    const body = statusEvent({
      type: "voice-dial-failed",
      peerId: "12D3KooWAAA",
      message: SENTINEL,
    });
    expect(body.sev).toBe("error");
    expect(KIND_SEV["voice.pc.new"]).toBe("info");
  });

  it("keeps the relayed flag, which decides voice-relayed-only", () => {
    const body = statusEvent({
      type: "voice-ice-connected",
      peerId: "12D3KooWAAA",
      relayed: true,
      message: SENTINEL,
    });
    expect(body.d).toEqual({ relayed: true });
  });

  it("never copies a status message into the event", () => {
    for (const status of ALL_STATUSES) {
      const body = statusEvent(status);
      expect(JSON.stringify(body)).not.toContain(SENTINEL);
    }
  });
});

describe("transportEvent", () => {
  beforeEach(() => {
    resetRecorderForTest();
    beginSession("s", 0);
  });

  it("maps the connection lifecycle", () => {
    expect(transportEvent("connect", ["p1"])).toMatchObject({
      kind: "peer.connect",
      peer: "p1",
    });
    expect(transportEvent("disconnect", ["p1"])?.kind).toBe("peer.disconnect");
    expect(transportEvent("streamProven", ["p1"])?.kind).toBe("stream.proven");
    expect(transportEvent("streamLost", ["p1"])?.kind).toBe("stream.lost");
  });

  it("splits relayChanged into two kinds", () => {
    expect(transportEvent("relayChanged", ["p1", true])?.kind).toBe(
      "peer.relayed"
    );
    expect(transportEvent("relayChanged", ["p1", false])?.kind).toBe(
      "peer.direct"
    );
  });

  it("replaces a room code with an ordinal", () => {
    const code = "0123456789abcdef";
    const body = transportEvent("roomPeers", [code, ["p1", "p2"]]);
    expect(body).toMatchObject({ kind: "rv.peers", room: "r1" });
    expect(body?.d).toEqual({ count: 2 });
    expect(JSON.stringify(body)).not.toContain(code);
  });

  it("reduces a message to its byte length", () => {
    const payload = new Uint8Array([1, 2, 3, 4, 5]);
    const body = transportEvent("message", ["p1", payload, "roomcode1234"]);
    expect(body).toMatchObject({ kind: "app.msg.in", peer: "p1", room: "r1" });
    expect(body?.d).toEqual({ bytes: 5 });
    expect(JSON.stringify(body)).not.toContain("roomcode1234");
  });

  it("keeps a null room null rather than minting an ordinal", () => {
    const body = transportEvent("message", ["p1", new Uint8Array(0), null]);
    expect(body?.room).toBeNull();
    expect(refs().rooms()).toEqual([]);
  });

  it("labels the device-sync bus so its events are distinguishable", () => {
    const body = transportEvent("connect", ["p1"], "sync");
    expect(body?.d).toEqual({ bus: "sync" });
  });

  it("does not label the main bus", () => {
    expect(transportEvent("connect", ["p1"], "main")?.d).toBeUndefined();
  });

  it("returns null for an event with no diagnostic content", () => {
    expect(transportEvent("somethingElse", [])).toBeNull();
    expect(transportEvent("status", [])).toBeNull();
  });
});

describe("voiceEvent", () => {
  it("maps the voice roster and media flow", () => {
    expect(voiceEvent("peerJoined", ["p1"])?.kind).toBe("voice.join");
    expect(voiceEvent("peerLeft", ["p1"])?.kind).toBe("voice.leave");
    expect(voiceEvent("trackAdded", ["p1", {}])?.kind).toBe(
      "voice.media.resume"
    );
    expect(voiceEvent("trackRemoved", ["p1"])?.kind).toBe("voice.teardown");
  });

  it("records the device class but never the deviceId", () => {
    const body = voiceEvent("deviceChanged", ["input", "hw:deadbeef"]);
    expect(body?.d).toEqual({ audioDevice: "input" });
    expect(JSON.stringify(body)).not.toContain("hw:deadbeef");
  });

  it("reduces an error to a name and message", () => {
    const body = voiceEvent("error", [new TypeError("boom")]);
    expect(body).toMatchObject({ kind: "voice.failed" });
    expect(body?.d).toEqual({ message: "TypeError: boom" });
  });

  it("reuses the status table", () => {
    expect(voiceEvent("status", [{ type: "voice-degraded", peerId: "p1", message: SENTINEL }])?.kind).toBe(
      "voice.degraded"
    );
  });
});

describe("videoEvent", () => {
  it("maps the SFU track lifecycle", () => {
    expect(videoEvent("trackAdded", ["p1", {}, "camera"])).toMatchObject({
      kind: "sfu.track.added",
      peer: "p1",
      d: { source: "camera" },
    });
    expect(videoEvent("trackStalled", ["p1", "screen"])).toMatchObject({
      kind: "sfu.track.stalled",
      d: { source: "screen" },
    });
  });

  it("discriminates the four transmission events by phase", () => {
    const phases = [
      ["transmissionAvailable", "available"],
      ["transmissionEnded", "ended"],
      ["transmissionWatched", "watched"],
      ["transmissionWatchEnded", "watch-ended"],
    ] as const;
    for (const [event, phase] of phases) {
      expect(videoEvent(event, ["p1"])).toMatchObject({
        kind: "sfu.consume",
        d: { phase },
      });
    }
  });

  it("skips the events the SFU snapshot already covers", () => {
    // The SFU's own roster arrives with far higher fidelity in an `sfu.diag`
    // snapshot, which is what the sfu-room-split rule reads.
    expect(videoEvent("peerJoined", ["p1"])).toBeNull();
    expect(videoEvent("peerLeft", ["p1"])).toBeNull();
    expect(videoEvent("outputVolumeChanged", [0.5])).toBeNull();
  });
});

describe("counter sampling", () => {
  it("flattens bags with a prefix so three bags cannot collide", () => {
    expect(
      flattenBags({ t: { connects: 1 }, a: { connects: 9 }, f: {} })
    ).toEqual({ "t.connects": 1, "a.connects": 9 });
  });

  it("reports only what changed", () => {
    expect(
      diffCounters({ "t.a": 5, "t.b": 1 }, { "t.a": 7, "t.b": 1 })
    ).toEqual({ "t.a": 2 });
  });

  it("treats a missing key as zero", () => {
    expect(diffCounters({}, { "t.a": 3 })).toEqual({ "t.a": 3 });
  });

  it("emits nothing when nothing moved", () => {
    expect(counterEvents(diffCounters({ "t.a": 1 }, { "t.a": 1 }))).toEqual([]);
  });

  it("chunks a wide delta rather than losing the overflow", () => {
    // Three bags carry 24 counters and a detail bag holds 12 keys.
    const delta: Record<string, number> = {};
    for (let i = 0; i < 25; i++) delta[`t.k${i}`] = 1;
    const events = counterEvents(delta);
    expect(events).toHaveLength(3);
    expect(Object.keys(events[0].d ?? {})).toHaveLength(12);
    expect(Object.keys(events[2].d ?? {})).toHaveLength(1);
    const seen = events.flatMap((e) => Object.keys(e.d ?? {}));
    expect(new Set(seen).size).toBe(25);
  });
});
