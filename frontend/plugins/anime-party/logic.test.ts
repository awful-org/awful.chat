import { describe, expect, it } from "vitest";
import { initialState, reduce, type AnimePartyState } from "./logic";

const HOST = "did:host";
const HOST_NAME = "Host";
const ALICE = "did:alice";
const BOB = "did:bob";

function newParty(): AnimePartyState {
  return initialState({ ownerDid: HOST, title: "Cowboy Bebop", episodeCount: 26 });
}

function ctx(senderDid: string, senderName: string, opts?: { ephemeral?: boolean }) {
  return {
    senderDid,
    senderName,
    updateId: `${senderDid}-${Math.random()}`,
    lamport: 1,
    ephemeral: opts?.ephemeral ?? false,
  };
}

function tick(overrides: Partial<Record<string, unknown>> = {}) {
  return { paused: false, position: 10, atMs: 1_000, rate: 1, seq: 1, ...overrides };
}

describe("initialState", () => {
  it("seeds the owner as the sole member and starts paused, open, at episode 1", () => {
    const party = newParty();
    expect(party.ownerDid).toBe(HOST);
    expect(party.episode).toBe(1);
    expect(party.paused).toBe(true);
    expect(party.closed).toBe(false);
    expect([...party.members.entries()]).toEqual([[HOST, "Host"]]);
  });

  it("is born closed when the card carries no owner - a forged card, not a hostless party", () => {
    const party = initialState({ title: "no owner" });
    expect(party.closed).toBe(true);
    expect(party.members.size).toBe(0);
  });

  it("falls back to a plain title and drops a cover image off the AniList host", () => {
    const party = initialState({
      title: 123,
      coverImageUrl: "https://evil.example/cover.jpg",
    });
    expect(party.title).toBe("Untitled anime");
    expect(party.coverImageUrl).toBeNull();
  });

  it("accepts a cover image from AniList's own CDN", () => {
    const party = initialState({
      ownerDid: HOST,
      coverImageUrl: "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/1.jpg",
    });
    expect(party.coverImageUrl).toBe(
      "https://s4.anilist.co/file/anilistcdn/media/anime/cover/medium/1.jpg"
    );
  });
});

describe("join / leave", () => {
  it("adds a new member under their sender name", () => {
    const party = newParty();
    const next = reduce(party, { data: { action: "join" } }, ctx(ALICE, "Alice"));
    expect([...next.members.keys()]).toEqual([HOST, ALICE]);
  });

  it("is a no-op for someone already a member", () => {
    let party = newParty();
    party = reduce(party, { data: { action: "join" } }, ctx(ALICE, "Alice"));
    const again = reduce(party, { data: { action: "join" } }, ctx(ALICE, "Alice"));
    expect(again).toBe(party);
  });

  it("removes a member who leaves", () => {
    let party = newParty();
    party = reduce(party, { data: { action: "join" } }, ctx(ALICE, "Alice"));
    const next = reduce(party, { data: { action: "leave" } }, ctx(ALICE, "Alice"));
    expect(next.members.has(ALICE)).toBe(false);
  });

  it("refuses to let the owner leave through the leave action", () => {
    const party = newParty();
    const next = reduce(party, { data: { action: "leave" } }, ctx(HOST, HOST_NAME));
    expect(next).toBe(party);
    expect(next.members.has(HOST)).toBe(true);
  });

  it("is a no-op for someone who was never a member", () => {
    const party = newParty();
    const next = reduce(party, { data: { action: "leave" } }, ctx(ALICE, "Alice"));
    expect(next).toBe(party);
  });
});

describe("select-episode", () => {
  it("lets the owner jump to an episode within the known count, resetting playback", () => {
    const party = newParty();
    const next = reduce(party, { data: { action: "select-episode", episode: 5 } }, ctx(HOST, HOST_NAME));
    expect(next.episode).toBe(5);
    expect(next.paused).toBe(true);
    expect(next.lastTick).toBeNull();
  });

  it("refuses a non-owner's episode selection", () => {
    const party = newParty();
    const next = reduce(party, { data: { action: "select-episode", episode: 5 } }, ctx(ALICE, "Alice"));
    expect(next).toBe(party);
  });

  it("refuses an episode past the known episode count", () => {
    const party = newParty();
    const next = reduce(party, { data: { action: "select-episode", episode: 27 } }, ctx(HOST, HOST_NAME));
    expect(next).toBe(party);
  });

  it("refuses a non-integer or non-positive episode", () => {
    const party = newParty();
    expect(reduce(party, { data: { action: "select-episode", episode: 0 } }, ctx(HOST, HOST_NAME))).toBe(party);
    expect(reduce(party, { data: { action: "select-episode", episode: 1.5 } }, ctx(HOST, HOST_NAME))).toBe(party);
  });

  it("clears a stale heartbeat so followers do not see the old episode's position", () => {
    let party = newParty();
    party = reduce(
      party,
      { data: { action: "tick", tick: tick() } },
      ctx(HOST, HOST_NAME, { ephemeral: true })
    );
    expect(party.lastTick).not.toBeNull();
    const next = reduce(party, { data: { action: "select-episode", episode: 2 } }, ctx(HOST, HOST_NAME));
    expect(next.lastTick).toBeNull();
  });
});

describe("pause / resume", () => {
  it("the owner pauses a playing party", () => {
    let party = newParty();
    party = reduce(party, { data: { action: "play" } }, ctx(HOST, HOST_NAME));
    expect(party.paused).toBe(false);
    const next = reduce(party, { data: { action: "pause" } }, ctx(HOST, HOST_NAME));
    expect(next.paused).toBe(true);
  });

  it("resume is a no-op when already playing, and vice versa", () => {
    let party = newParty();
    party = reduce(party, { data: { action: "play" } }, ctx(HOST, HOST_NAME));
    const again = reduce(party, { data: { action: "play" } }, ctx(HOST, HOST_NAME));
    expect(again).toBe(party);
    const paused = reduce(party, { data: { action: "pause" } }, ctx(HOST, HOST_NAME));
    const againPaused = reduce(paused, { data: { action: "pause" } }, ctx(HOST, HOST_NAME));
    expect(againPaused).toBe(paused);
  });

  it("refuses play/pause from anyone but the owner", () => {
    const party = newParty();
    expect(reduce(party, { data: { action: "play" } }, ctx(ALICE, "Alice"))).toBe(party);
    expect(reduce(party, { data: { action: "pause" } }, ctx(ALICE, "Alice"))).toBe(party);
  });
});

describe("close and host departure", () => {
  it("only the owner can close the party", () => {
    const party = newParty();
    expect(reduce(party, { data: { action: "close" } }, ctx(ALICE, "Alice"))).toBe(party);
    const next = reduce(party, { data: { action: "close" } }, ctx(HOST, HOST_NAME));
    expect(next.closed).toBe(true);
    expect(next.paused).toBe(true);
  });

  it("every action is a no-op once closed, including join", () => {
    let party = newParty();
    party = reduce(party, { data: { action: "close" } }, ctx(HOST, HOST_NAME));
    const next = reduce(party, { data: { action: "join" } }, ctx(ALICE, "Alice"));
    expect(next).toBe(party);
  });

  it("closes on host-left, but only from the longest-standing non-owner member", () => {
    let party = newParty();
    party = reduce(party, { data: { action: "join" } }, ctx(ALICE, "Alice"));
    party = reduce(party, { data: { action: "join" } }, ctx(BOB, "Bob"));
    // Bob is not the designated observer (Alice joined first) - his attempt
    // must be rejected even though he is a real member.
    const rejected = reduce(party, { data: { action: "host-left" } }, ctx(BOB, "Bob"));
    expect(rejected).toBe(party);
    const accepted = reduce(party, { data: { action: "host-left" } }, ctx(ALICE, "Alice"));
    expect(accepted.closed).toBe(true);
    expect(accepted.paused).toBe(true);
  });

  it("refuses host-left from a non-member", () => {
    const party = newParty();
    const next = reduce(party, { data: { action: "host-left" } }, ctx(ALICE, "Alice"));
    expect(next).toBe(party);
  });
});

describe("late-joiner sync round trip", () => {
  it("records a member's resync request", () => {
    let party = newParty();
    party = reduce(party, { data: { action: "join" } }, ctx(ALICE, "Alice"));
    const next = reduce(
      party,
      { data: { action: "resync-request", requestId: "request-alice-1" } },
      ctx(ALICE, "Alice")
    );
    expect(next.syncRequest).toEqual({ id: "request-alice-1", requesterDid: ALICE });
  });

  it("refuses a resync request from a non-member, and a malformed request id", () => {
    const party = newParty();
    expect(
      reduce(party, { data: { action: "resync-request", requestId: "request-alice-1" } }, ctx(ALICE, "Alice"))
    ).toBe(party);
    const joined = reduce(party, { data: { action: "join" } }, ctx(ALICE, "Alice"));
    expect(
      reduce(joined, { data: { action: "resync-request", requestId: "short" } }, ctx(ALICE, "Alice"))
    ).toBe(joined);
  });

  it("the owner's response targets the requester and seeds lastTick, without a round trip per frame", () => {
    let party = newParty();
    party = reduce(party, { data: { action: "join" } }, ctx(ALICE, "Alice"));
    party = reduce(
      party,
      { data: { action: "resync-request", requestId: "request-alice-1" } },
      ctx(ALICE, "Alice")
    );
    const responseTick = tick({ position: 42, atMs: 5_000 });
    const next = reduce(
      party,
      {
        data: {
          action: "resync-response",
          targetDid: ALICE,
          requestId: "request-alice-1",
          tick: responseTick,
        },
      },
      ctx(HOST, HOST_NAME)
    );
    expect(next.syncResponse).toEqual({
      id: "request-alice-1",
      targetDid: ALICE,
      tick: responseTick,
    });
    // The request is cleared once answered - nothing keeps re-triggering it.
    expect(next.syncRequest).toBeUndefined();
    expect(next.lastTick).toEqual(responseTick);
  });

  it("refuses a resync response from anyone but the owner", () => {
    let party = newParty();
    party = reduce(party, { data: { action: "join" } }, ctx(ALICE, "Alice"));
    const next = reduce(
      party,
      {
        data: {
          action: "resync-response",
          targetDid: ALICE,
          requestId: "x",
          tick: tick(),
        },
      },
      ctx(BOB, "Bob")
    );
    expect(next).toBe(party);
  });
});

describe("ephemeral tick", () => {
  it("folds a valid tick from the owner into lastTick without touching persisted fields", () => {
    const party = newParty();
    const next = reduce(
      party,
      { data: { action: "tick", tick: tick({ position: 12.5, seq: 1 }) } },
      ctx(HOST, HOST_NAME, { ephemeral: true })
    );
    expect(next.lastTick).toEqual(tick({ position: 12.5, seq: 1 }));
    expect(next.paused).toBe(party.paused);
  });

  it("refuses a tick from anyone but the owner", () => {
    const party = newParty();
    const next = reduce(
      party,
      { data: { action: "tick", tick: tick() } },
      ctx(ALICE, "Alice", { ephemeral: true })
    );
    expect(next).toBe(party);
  });

  it("refuses a malformed tick", () => {
    const party = newParty();
    const malformed = [
      { ...tick(), position: -1 },
      { ...tick(), rate: 0 },
      { ...tick(), rate: 5 },
      { ...tick(), seq: 1.5 },
      { ...tick(), paused: "no" },
      null,
      "not an object",
    ];
    for (const bad of malformed) {
      const next = reduce(
        party,
        { data: { action: "tick", tick: bad } },
        ctx(HOST, HOST_NAME, { ephemeral: true })
      );
      expect(next).toBe(party);
    }
  });

  it("drops a reordered (stale) tick so the shown position never rolls backwards", () => {
    let party = newParty();
    party = reduce(
      party,
      { data: { action: "tick", tick: tick({ seq: 5, position: 50 }) } },
      ctx(HOST, HOST_NAME, { ephemeral: true })
    );
    const stale = reduce(
      party,
      { data: { action: "tick", tick: tick({ seq: 3, position: 10 }) } },
      ctx(HOST, HOST_NAME, { ephemeral: true })
    );
    expect(stale).toBe(party);
    expect(stale.lastTick?.position).toBe(50);
  });

  it("stays well under the 4 KB ephemeral cap even packed alongside a cardId and pluginId", () => {
    const envelope = {
      pluginId: "anime-party",
      cardId: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
      data: { action: "tick", tick: tick({ position: 12345.678, seq: 999_999 }) },
    };
    expect(JSON.stringify(envelope).length).toBeLessThan(4096);
  });
});
