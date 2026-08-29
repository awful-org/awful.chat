import { describe, expect, it } from "vitest";
import { spotlight, type SpeakerState, type SpotlightTile } from "./spotlight";

const NOW = 1_000_000;

const tile = (p: Partial<SpotlightTile> & { id: string }): SpotlightTile => ({
  kind: "camera",
  isLocal: false,
  peerId: p.id,
  videoTrack: null,
  ...p,
});

const cam = {} as MediaStreamTrack;

/** Peers speaking right now, each with when their current run began. */
const speaking = (
  runs: Array<[string, number]> = [],
  silent: Array<[string, number]> = []
): SpeakerState => ({
  speaking: new Set(runs.map(([id]) => id)),
  speakingSince: new Map(runs),
  lastSpokeAt: new Map([...runs, ...silent]),
});

/** Nobody speaking; entries are when each last spoke. */
const silentSince = (entries: Array<[string, number]> = []): SpeakerState => ({
  speaking: new Set(),
  speakingSince: new Map(),
  lastSpokeAt: new Map(entries),
});

describe("rule 1: a pin wins and is sticky", () => {
  it("returns the pin over a screen share and an active speaker", () => {
    const tiles = [
      tile({ id: "alice" }),
      tile({ id: "bobscreen", kind: "screen", peerId: "bob" }),
      tile({ id: "carol" }),
    ];
    expect(
      spotlight(tiles, "alice", "bob", speaking([["carol", NOW - 5000]]), null, NOW)
    ).toBe("alice");
  });

  it("falls through the moment the pinned tile disappears", () => {
    const tiles = [tile({ id: "bob" })];
    expect(spotlight(tiles, "ghost", null, speaking(), null, NOW)).toBe("bob");
  });
});

describe("rule 2: screen share", () => {
  it("prefers the share being watched", () => {
    const tiles = [
      tile({ id: "s1", kind: "screen", peerId: "alice" }),
      tile({ id: "s2", kind: "screen", peerId: "bob" }),
    ];
    expect(spotlight(tiles, null, "bob", speaking(), null, NOW)).toBe("s2");
  });

  it("takes any remote share when none is being watched", () => {
    const tiles = [tile({ id: "s1", kind: "screen", peerId: "alice" })];
    expect(spotlight(tiles, null, null, speaking(), null, NOW)).toBe("s1");
  });

  it("never shows the user's own share", () => {
    const tiles = [
      tile({ id: "mine", kind: "screen", isLocal: true, peerId: "me" }),
      tile({ id: "bob" }),
    ];
    expect(spotlight(tiles, null, null, speaking(), null, NOW)).toBe("bob");
  });
});

// The rule is 1.5s of CONTINUOUS speech, measured from the start of the run.
// Measuring from the last moment of speech instead selects people shortly
// AFTER they stop talking, and never while they are talking.
describe("rule 3: active speaker with hysteresis", () => {
  const tiles = [tile({ id: "alice" }), tile({ id: "bob" })];

  it("does NOT hand over to someone who just started", () => {
    expect(
      spotlight(tiles, null, null, speaking([["bob", NOW - 200]]), "alice", NOW)
    ).toBe("alice");
  });

  it("hands over once they have held it for 1.5s", () => {
    expect(
      spotlight(tiles, null, null, speaking([["bob", NOW - 1500]]), null, NOW)
    ).toBe("bob");
  });

  it("spotlights whoever is talking right now, not after they stop", () => {
    // The regression this replaces: a peer mid-sentence was skipped, and only
    // became eligible once silent.
    const s = speaking([["alice", NOW - 3000]]);
    expect(spotlight(tiles, null, null, s, null, NOW)).toBe("alice");
  });

  it("keeps the incumbent while they are still speaking", () => {
    const s = speaking([
      ["alice", NOW - 4000],
      ["bob", NOW - 3000],
    ]);
    expect(spotlight(tiles, null, null, s, "alice", NOW)).toBe("alice");
  });

  it("keeps the incumbent through a short pause, then lets go", () => {
    const held = silentSince([["alice", NOW - 1900]]);
    expect(spotlight(tiles, null, null, held, "alice", NOW)).toBe("alice");

    const lapsed: SpeakerState = {
      speaking: new Set(["bob"]),
      speakingSince: new Map([["bob", NOW - 2000]]),
      lastSpokeAt: new Map([
        ["alice", NOW - 2100],
        ["bob", NOW - 2000],
      ]),
    };
    expect(spotlight(tiles, null, null, lapsed, "alice", NOW)).toBe("bob");
  });

  it("prefers a camera when two have spoken equally long", () => {
    const withCam = [tile({ id: "alice" }), tile({ id: "bob", videoTrack: cam })];
    const s = speaking([
      ["alice", NOW - 3000],
      ["bob", NOW - 3000],
    ]);
    expect(spotlight(withCam, null, null, s, null, NOW)).toBe("bob");
  });

  // The incumbent-hold path had no isLocal filter, unlike the challenger loop
  // and rule 4. Alone in a call rule 5 makes the LOCAL tile the previous, and
  // an unmuted local user is legitimately in `speaking` - so the panel stayed
  // on yourself while a remote peer talked.
  it("does not let a local incumbent hold the spot against a remote speaker", () => {
    const withSelf = [
      tile({ id: "local-camera", isLocal: true, peerId: "me", videoTrack: cam }),
      tile({ id: "bob" }),
    ];
    const s = speaking([
      ["me", NOW - 5000],
      ["bob", NOW - 5000],
    ]);
    expect(spotlight(withSelf, null, null, s, "local-camera", NOW)).toBe("bob");
  });

  it("ignores the local user talking", () => {
    const withSelf = [
      tile({ id: "me", isLocal: true, peerId: "me" }),
      tile({ id: "bob" }),
    ];
    const s = speaking([["me", NOW - 5000]]);
    expect(spotlight(withSelf, null, null, s, null, NOW)).not.toBe("me");
  });
});

describe("rule 2 ordering", () => {
  // "Newest first" used to depend on the caller's array order, which nothing
  // typed or tested. startedAt makes it explicit.
  it("prefers the most recently started share", () => {
    const tiles = [
      tile({ id: "old", kind: "screen", peerId: "alice", startedAt: NOW - 9000 }),
      tile({ id: "new", kind: "screen", peerId: "bob", startedAt: NOW - 1000 }),
    ];
    expect(spotlight(tiles, null, null, speaking(), null, NOW)).toBe("new");
  });

  it("keeps the caller's order when no tile is dated", () => {
    const tiles = [
      tile({ id: "first", kind: "screen", peerId: "alice" }),
      tile({ id: "second", kind: "screen", peerId: "bob" }),
    ];
    expect(spotlight(tiles, null, null, speaking(), null, NOW)).toBe("first");
  });
});

describe("rule 4: fallbacks", () => {
  it("keeps the previous tile when it still exists", () => {
    const tiles = [tile({ id: "alice" }), tile({ id: "bob" })];
    expect(spotlight(tiles, null, null, speaking(), "bob", NOW)).toBe("bob");
  });

  it("prefers a remote with a camera when there is no previous", () => {
    const tiles = [tile({ id: "alice" }), tile({ id: "bob", videoTrack: cam })];
    expect(spotlight(tiles, null, null, speaking(), null, NOW)).toBe("bob");
  });

  it("falls back to an avatar tile when nobody has a camera", () => {
    const tiles = [tile({ id: "alice" }), tile({ id: "bob" })];
    expect(spotlight(tiles, null, null, speaking(), null, NOW)).toBe("alice");
  });
});

describe("rule 5: alone in the call", () => {
  it("shows the local camera", () => {
    const tiles = [tile({ id: "me", isLocal: true, peerId: "me", videoTrack: cam })];
    expect(spotlight(tiles, null, null, speaking(), null, NOW)).toBe("me");
  });

  it("returns null when there is nothing at all", () => {
    expect(spotlight([], null, null, speaking(), null, NOW)).toBeNull();
  });
});

describe("edge cases from the spec", () => {
  it("moves on the same frame when a spotlighted peer leaves", () => {
    const after = [tile({ id: "bob" })];
    expect(spotlight(after, null, null, speaking(), "alice", NOW)).toBe("bob");
  });

  it("moves on when the share ends", () => {
    const after = [tile({ id: "alice" })];
    expect(spotlight(after, null, "bob", speaking(), "bobscreen", NOW)).toBe(
      "alice"
    );
  });

  it("does not flicker when two people talk over each other", () => {
    const tiles = [tile({ id: "alice" }), tile({ id: "bob" })];
    const s = speaking([
      ["alice", NOW - 5000],
      ["bob", NOW - 400],
    ]);
    expect(spotlight(tiles, null, null, s, "alice", NOW)).toBe("alice");
  });
});
