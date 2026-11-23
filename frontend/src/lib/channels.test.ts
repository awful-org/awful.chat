import { describe, expect, it } from "vitest";
import {
  DEFAULT_CHANNEL_NAMES,
  MAX_CHANNELS,
  MAX_CHANNEL_FUTURE_MS,
  MAX_CHANNEL_TOMBSTONES,
  channelKey,
  createChannelEntry,
  deleteChannelEntry,
  entryBeats,
  findLiveChannel,
  isChannelId,
  liveChannels,
  mergeChannelLists,
  newChannelId,
  normalizeChannelList,
  parseChannelEntry,
  parseChannelList,
  renameChannelEntry,
  reorderChannelEntries,
  sameChannelList,
  sanitizeChannelName,
  type Channel,
} from "./channels";

const NOW = 1_800_000_000_000;

function ch(id: string, over: Partial<Channel> = {}): Channel {
  return { id, kind: "text", name: id.slice(0, 8), position: 1, updatedAt: NOW - 1000, ...over };
}
const A = "aaaaaaaa";
const B = "bbbbbbbb";

describe("channel ids", () => {
  it("mints ids of the accepted shape, and accepts nothing else", () => {
    for (let i = 0; i < 50; i++) expect(isChannelId(newChannelId())).toBe(true);
    expect(new Set(Array.from({ length: 100 }, newChannelId)).size).toBe(100);
    for (const bad of ["", "short", "UPPERCASE", "has-dash1", "a".repeat(33), 1234567890, null, undefined]) {
      expect(isChannelId(bad)).toBe(false);
    }
    expect(isChannelId("a".repeat(8))).toBe(true);
    expect(isChannelId("0".repeat(32))).toBe(true);
  });
});

describe("names", () => {
  it("strips control and bidi characters, collapses space, caps at 32 characters", () => {
    expect(sanitizeChannelName("  off‮topic \n chat ")).toBe("offtopic chat");
    expect(sanitizeChannelName("x".repeat(40))).toBe("x".repeat(32));
    // By code point: a cut never leaves half an emoji.
    expect(sanitizeChannelName("🙂".repeat(40))).toBe("🙂".repeat(32));
    expect(sanitizeChannelName("\u0000\u0007  ")).toBeNull();
    expect(sanitizeChannelName(42)).toBeNull();
  });
});

describe("parsing an untrusted entry", () => {
  it("keeps only the fields of a channel, checked", () => {
    expect(parseChannelEntry({ ...ch(A), extra: "x", deleted: true })).toEqual({ ...ch(A), deleted: true });
    expect(parseChannelEntry({ ...ch(A), position: 2.6 })?.position).toBe(3);
    expect(parseChannelEntry({ ...ch(A), position: -5 })?.position).toBe(0);
    expect(parseChannelEntry({ ...ch(A), position: 1e12 })?.position).toBe(1_000_000);
  });

  it("refuses anything malformed", () => {
    const bad: unknown[] = [
      null, "x", [], { ...ch(A), kind: "video" }, { ...ch(A), id: "NOPE-NOPE" },
      { ...ch(A), name: "   " }, { ...ch(A), position: Number.NaN }, { ...ch(A), position: "1" },
      { ...ch(A), updatedAt: 0 }, { ...ch(A), updatedAt: 1.5 }, { ...ch(A), updatedAt: Number.MAX_VALUE },
      { ...ch(A), deleted: false }, { ...ch(A), deleted: "yes" },
      // The originals can be renamed, never deleted.
      { ...ch(""), deleted: true },
    ];
    for (const raw of bad) expect(parseChannelEntry(raw)).toBeNull();
    expect(parseChannelEntry(ch("", { name: "lobby" }))).not.toBeNull();
  });

  it("takes an original's position under the same checks as any other, and nothing more", () => {
    const moved = ch("", { kind: "voice", name: "hangout", position: 4 });
    expect(parseChannelEntry({ ...moved, extra: 1 })).toEqual(moved);
    expect(parseChannelEntry({ ...moved, position: -2 })?.position).toBe(0);
    expect(parseChannelEntry({ ...moved, position: 1e12 })?.position).toBe(1_000_000);
    for (const position of [undefined, null, "1", Number.NaN, Infinity]) {
      expect(parseChannelEntry({ ...moved, position })).toBeNull();
    }
    expect(parseChannelEntry({ ...moved, deleted: true })).toBeNull();
    expect(parseChannelEntry({ ...moved, kind: "video" })).toBeNull();
  });

  it("parses a list by dropping what does not parse", () => {
    expect(parseChannelList([ch(A), { junk: 1 }, ch(B)]).map((c) => c.id)).toEqual([A, B]);
    expect(parseChannelList("nope")).toEqual([]);
  });
});

describe("the merge rule", () => {
  it("takes the newer change to each entry", () => {
    const ours = [ch(A, { name: "old", updatedAt: NOW - 10 }), ch(B, { name: "mine", updatedAt: NOW - 1 })];
    const theirs = [ch(A, { name: "new", updatedAt: NOW - 5 }), ch(B, { name: "theirs", updatedAt: NOW - 9 })];
    const { merged, changed, behind } = mergeChannelLists(ours, theirs, NOW);
    expect(merged.find((c) => c.id === A)?.name).toBe("new");
    expect(merged.find((c) => c.id === B)?.name).toBe("mine");
    expect(changed).toBe(true);
    // They lack our newer B: they get an answer.
    expect(behind).toBe(true);
  });

  it("a delete is a tombstone that wins by its stamp, and an older live copy cannot undo it", () => {
    const deleted = { ...ch(A, { updatedAt: NOW - 5 }), deleted: true as const };
    const stale = ch(A, { name: "back from the dead", updatedAt: NOW - 50 });
    const r = mergeChannelLists([deleted], [stale], NOW);
    expect(r.merged).toEqual([deleted]);
    expect(r.changed).toBe(false);
    expect(r.behind).toBe(true);
    // A rename made after the delete does bring it back: that is newer.
    const revived = ch(A, { name: "revived", updatedAt: NOW - 1 });
    expect(mergeChannelLists([deleted], [revived], NOW).merged).toEqual([revived]);
  });

  it("ignores a change stamped more than an hour past our clock, without answering it forever", () => {
    const future = ch(A, { name: "hijack", updatedAt: NOW + MAX_CHANNEL_FUTURE_MS + 1 });
    const ours = [ch(A, { name: "ours" })];
    const r = mergeChannelLists(ours, [future], NOW);
    expect(r.merged).toEqual(normalizeChannelList(ours));
    expect(r.changed).toBe(false);
    // Our older copy does not beat what they sent, so we do not answer it:
    // otherwise a member with a fast clock would be answered on every frame.
    expect(r.behind).toBe(false);
    const nearFuture = ch(A, { name: "fine", updatedAt: NOW + MAX_CHANNEL_FUTURE_MS });
    expect(mergeChannelLists(ours, [nearFuture], NOW).merged[0].name).toBe("fine");
  });

  it("settles a tie at the same stamp the same way on both sides", () => {
    const x = ch(A, { name: "Alpha", updatedAt: NOW - 1 });
    const y = ch(A, { name: "Beta", updatedAt: NOW - 1 });
    expect(entryBeats(x, y)).not.toBe(entryBeats(y, x));
    const left = mergeChannelLists([x], [y], NOW).merged;
    const right = mergeChannelLists([y], [x], NOW).merged;
    expect(sameChannelList(left, right)).toBe(true);
  });

  it("is order independent: any members folding the same entries hold the same list", () => {
    const entries = [
      ch(A, { updatedAt: NOW - 9 }), ch(A, { name: "renamed", updatedAt: NOW - 3 }),
      ch(B), { ...ch(B, { updatedAt: NOW - 2 }), deleted: true as const },
      ch("cccccccc", { position: 4 }), ch("", { name: "lobby", updatedAt: NOW - 7 }),
    ];
    const forward = entries.reduce<Channel[]>((acc, e) => mergeChannelLists(acc, [e], NOW).merged, []);
    const backward = [...entries].reverse().reduce<Channel[]>((acc, e) => mergeChannelLists(acc, [e], NOW).merged, []);
    expect(sameChannelList(forward, backward)).toBe(true);
    expect(sameChannelList(forward, mergeChannelLists([], entries, NOW).merged)).toBe(true);
  });

  it("caps live channels and tombstones the same way for everyone", () => {
    const live = Array.from({ length: MAX_CHANNELS + 5 }, (_, i) => ch(`live${String(i).padStart(4, "0")}`, { position: i }));
    const dead = Array.from({ length: MAX_CHANNEL_TOMBSTONES + 5 }, (_, i) => ({
      ...ch(`dead${String(i).padStart(4, "0")}`), deleted: true as const, updatedAt: NOW - 10_000 + i,
    }));
    const list = normalizeChannelList([...live, ...dead]);
    expect(list.filter((c) => !c.deleted)).toHaveLength(MAX_CHANNELS);
    // The ones that sort last are the ones left out.
    expect(list.some((c) => c.id === "live0054")).toBe(false);
    expect(list.filter((c) => c.deleted)).toHaveLength(MAX_CHANNEL_TOMBSTONES);
    // The oldest deletes are the ones forgotten.
    expect(list.some((c) => c.id === "dead0000")).toBe(false);
    expect(list.some((c) => c.id === "dead0104")).toBe(true);
  });
});

describe("the list as members see it", () => {
  it("always holds the originals, first until one is moved, under their default names until renamed", () => {
    const list = [ch(B, { position: 2 }), ch(A, { position: 1 }), { ...ch("cccccccc"), deleted: true as const }];
    expect(liveChannels(list, "text").map((c) => [c.id, c.name])).toEqual([
      ["", DEFAULT_CHANNEL_NAMES.text], [A, A], [B, B],
    ]);
    expect(liveChannels(list, "voice").map((c) => c.id)).toEqual([""]);
    const renamed = [...list, ch("", { name: "lobby" })];
    expect(liveChannels(renamed, "text")[0].name).toBe("lobby");
    expect(liveChannels(renamed, "voice")[0].name).toBe(DEFAULT_CHANNEL_NAMES.voice);
    expect(findLiveChannel(list, "cccccccc")).toBeUndefined();
    expect(findLiveChannel(list, A)?.name).toBe(A);
    expect(findLiveChannel(list, A, "voice")).toBeUndefined();
  });

  it("shows an original where it was moved to, its kind alone", () => {
    const list = [ch(A, { position: 0 }), ch("", { name: "lobby", position: 1 }), ch(B, { position: 2 })];
    expect(liveChannels(list, "text").map((c) => c.id)).toEqual([A, "", B]);
    expect(liveChannels(list, "voice").map((c) => c.id)).toEqual([""]);
    // Whatever is first, the empty id is the original.
    expect(findLiveChannel(list, "")).toMatchObject({ id: "", name: "lobby", position: 1 });
    // At one position the original is in front, so an old list that says
    // nothing of it cannot put it behind another.
    expect(liveChannels([ch(A, { position: 0 })], "text").map((c) => c.id)).toEqual(["", A]);
  });

  it("keys a rename of an original by its kind, so text and voice are apart", () => {
    expect(channelKey({ id: "", kind: "text" })).not.toBe(channelKey({ id: "", kind: "voice" }));
    const both = normalizeChannelList([ch("", { name: "lobby" }), ch("", { kind: "voice", name: "hangout" })]);
    expect(both).toHaveLength(2);
  });
});

describe("edits", () => {
  it("creates after the last of its kind, refuses past the cap", () => {
    const c = createChannelEntry([ch(A, { position: 3 })], "text", " games ", NOW, "gamesgam");
    expect(c).toEqual({ id: "gamesgam", kind: "text", name: "games", position: 4, updatedAt: NOW });
    const full = Array.from({ length: MAX_CHANNELS }, (_, i) => ch(`full${String(i).padStart(4, "0")}`));
    expect(() => createChannelEntry(full, "text", "one more", NOW)).toThrow();
    expect(() => createChannelEntry([], "text", "   ", NOW)).toThrow();
    // After the original too, where that was moved to the end.
    expect(createChannelEntry([ch(A, { position: 0 }), ch("", { position: 5 })], "text", "last", NOW).position).toBe(6);
    expect(createChannelEntry([], "text", "first", NOW).position).toBe(1);
  });

  it("stamps a change after the one it replaces, even behind a fast clock elsewhere", () => {
    const held = [ch(A, { updatedAt: NOW + 60_000 })];
    expect(renameChannelEntry(held, "text", A, "x", NOW).updatedAt).toBe(NOW + 60_001);
    expect(deleteChannelEntry(held, "text", A, NOW)).toMatchObject({ deleted: true, updatedAt: NOW + 60_001 });
    expect(() => deleteChannelEntry(held, "text", "", NOW)).toThrow();
    expect(() => renameChannelEntry(held, "text", B, "x", NOW)).toThrow();
    // The original is renamed by an entry with the empty id.
    expect(renameChannelEntry([], "text", "", "lobby", NOW)).toMatchObject({ id: "", name: "lobby" });
  });

  it("reorders by restamping only the entries that move", () => {
    const list = [ch(A, { position: 1 }), ch(B, { position: 2 }), ch("cccccccc", { position: 3 })];
    const moved = reorderChannelEntries(list, "text", ["cccccccc", A], NOW);
    const after = liveChannels(mergeChannelLists(list, moved, NOW).merged, "text").map((c) => c.id);
    expect(after).toEqual(["", "cccccccc", A, B]);
    expect(moved.every((c) => c.updatedAt === NOW)).toBe(true);
    expect(reorderChannelEntries(list, "text", [A, B, "cccccccc"], NOW)).toEqual([]);
    // In front the original needs no entry of its own.
    expect(reorderChannelEntries(list, "text", ["", A, B, "cccccccc"], NOW)).toEqual([]);
  });

  it("moves an original like any other channel, the entry keeping its name", () => {
    const list = [ch(A, { position: 1 }), ch(B, { position: 2 })];
    const moved = reorderChannelEntries(list, "text", [A, "", B], NOW);
    expect(moved).toEqual([
      ch(A, { position: 0, updatedAt: NOW }),
      { id: "", kind: "text", name: DEFAULT_CHANNEL_NAMES.text, position: 1, updatedAt: NOW },
    ]);
    const after = mergeChannelLists(list, moved, NOW).merged;
    expect(liveChannels(after, "text").map((c) => c.id)).toEqual([A, "", B]);
    // A rename leaves it where it is, a move leaves its name alone.
    const renamed = mergeChannelLists(after, [renameChannelEntry(after, "text", "", "lobby", NOW + 1)], NOW + 1).merged;
    expect(liveChannels(renamed, "text").map((c) => c.name)).toEqual([A, "lobby", B]);
    const last = mergeChannelLists(
      renamed, reorderChannelEntries(renamed, "text", [A, B, ""], NOW + 2), NOW + 2
    ).merged;
    expect(liveChannels(last, "text").map((c) => c.name)).toEqual([A, B, "lobby"]);
    // Still never deleted.
    expect(() => deleteChannelEntry(last, "text", "", NOW + 3)).toThrow();
    // And back in front.
    const back = mergeChannelLists(
      last, reorderChannelEntries(last, "text", ["", A, B], NOW + 4), NOW + 4
    ).merged;
    expect(liveChannels(back, "text").map((c) => c.id)).toEqual(["", A, B]);
  });

  it("moves the original voice channel apart from the original chat", () => {
    const list = [ch(A, { kind: "voice", position: 1 }), ch(B, { position: 1 })];
    const after = mergeChannelLists(list, reorderChannelEntries(list, "voice", [A, ""], NOW), NOW).merged;
    expect(liveChannels(after, "voice").map((c) => c.id)).toEqual([A, ""]);
    expect(liveChannels(after, "text").map((c) => c.id)).toEqual(["", B]);
  });

  it("leaves an original an order does not name at the place it holds", () => {
    const list = [ch(A, { position: 0 }), ch("", { position: 1 }), ch(B, { position: 2 })];
    const after = mergeChannelLists(list, reorderChannelEntries(list, "text", [B, A], NOW), NOW).merged;
    expect(liveChannels(after, "text").map((c) => c.id)).toEqual([B, "", A]);
  });
});

/**
 * Two members announcing to each other the way the transport does: a frame
 * is folded in, and answered with ours when the sender is behind - but an
 * answer is never answered.
 */
describe("sync between two members", () => {
  interface Member { list: Channel[]; sent: number }
  function deliver(from: Member, to: Member, answer: boolean, now: number): void {
    from.sent += 1;
    const r = mergeChannelLists(to.list, parseChannelList(JSON.parse(JSON.stringify(from.list))), now);
    to.list = r.merged;
    if (r.behind && !answer) deliver(to, from, true, now);
  }

  it("carries a move of an original, and settles one made while apart by the newer stamp", () => {
    const alice: Member = { list: [ch(A, { position: 1 }), ch(B, { position: 2 })], sent: 0 };
    const bob: Member = { list: [...alice.list], sent: 0 };
    const move = (m: Member, order: string[], at: number) => {
      m.list = mergeChannelLists(m.list, reorderChannelEntries(m.list, "text", order, at), at).merged;
    };
    move(alice, [A, B, ""], NOW);
    deliver(alice, bob, false, NOW);
    expect(liveChannels(bob.list, "text").map((c) => c.id)).toEqual([A, B, ""]);
    // Apart: Alice puts it in front, then Bob between the two.
    move(alice, ["", A, B], NOW + 1);
    move(bob, [A, "", B], NOW + 2);
    deliver(alice, bob, false, NOW + 3);
    expect(sameChannelList(alice.list, bob.list)).toBe(true);
    // Bob's copy of the original, the newer, holds its place (1); Alice's
    // moves of the others hold theirs (A 1, B 2).
    expect(liveChannels(alice.list, "text").map((c) => c.id)).toEqual(["", A, B]);
  });

  it("converges after edits on both sides while apart, in one exchange", () => {
    const alice: Member = { list: [], sent: 0 };
    const bob: Member = { list: [], sent: 0 };
    let t = NOW;
    const edit = (m: Member, entries: Channel[]) => {
      m.list = mergeChannelLists(m.list, entries, t).merged;
    };
    const general = createChannelEntry([], "text", "general-2", t++, "shared01");
    edit(alice, [general]);
    deliver(alice, bob, false, t);
    expect(sameChannelList(alice.list, bob.list)).toBe(true);

    // Apart: Alice renames it and adds one; Bob deletes it and adds another.
    edit(alice, [renameChannelEntry(alice.list, "text", "shared01", "renamed", t++)]);
    edit(alice, [createChannelEntry(alice.list, "text", "alice", t++, "alice001")]);
    edit(bob, [deleteChannelEntry(bob.list, "text", "shared01", t++)]);
    edit(bob, [createChannelEntry(bob.list, "text", "bob", t++, "bob00001")]);

    alice.sent = 0;
    bob.sent = 0;
    deliver(bob, alice, false, t); // Bob comes back and announces
    expect(sameChannelList(alice.list, bob.list)).toBe(true);
    expect(alice.sent + bob.sent).toBe(2); // the announcement and one answer
    // The delete came after the rename, so it holds for both.
    expect(findLiveChannel(alice.list, "shared01")).toBeUndefined();
    // Both made at position 1 or 2 from what each held: by position, then id.
    expect(liveChannels(bob.list, "text").map((c) => c.name)).toEqual(["general", "bob", "alice"]);

    // Nothing left to say: a further announcement draws no answer.
    alice.sent = 0;
    bob.sent = 0;
    deliver(alice, bob, false, t);
    expect(alice.sent + bob.sent).toBe(1);
  });
});
