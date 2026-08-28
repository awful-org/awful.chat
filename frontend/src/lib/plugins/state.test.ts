import { beforeEach, describe, expect, it, vi } from "vitest";

// buildCardState/getCardState read the room's plugin rows out of IndexedDB;
// these tests drive that read directly so the fold order and the ownership
// filter can be asserted without a database.
vi.mock("$lib/storage", () => ({ getMessagesOfTypes: vi.fn() }));

import {
  buildCardState,
  cardStates,
  clearCardStates,
  foldComparator,
  foldUpdate,
  getCardState,
} from "./state.svelte";
import { getMessagesOfTypes } from "$lib/storage";
import { MessageType } from "$lib/types/message";
import type { Message } from "$lib/transport/transport.svelte";
import type { PluginDefinition } from "./api";

describe("foldComparator", () => {
  it("orders by lamport first", () => {
    const a = { lamport: 1, senderId: "b", id: "1" };
    const b = { lamport: 2, senderId: "a", id: "2" };
    expect(foldComparator(a, b)).toBeLessThan(0);
    expect(foldComparator(b, a)).toBeGreaterThan(0);
  });

  it("orders by senderId when lamports are equal", () => {
    const a = { lamport: 1, senderId: "alice", id: "1" };
    const b = { lamport: 1, senderId: "bob", id: "2" };
    expect(foldComparator(a, b)).toBeLessThan(0);
    expect(foldComparator(b, a)).toBeGreaterThan(0);
  });

  it("orders by id when lamports and senderIds are equal", () => {
    const a = { lamport: 1, senderId: "alice", id: "a" };
    const b = { lamport: 1, senderId: "alice", id: "b" };
    expect(foldComparator(a, b)).toBeLessThan(0);
    expect(foldComparator(b, a)).toBeGreaterThan(0);
  });

  it("returns 0 for identical messages", () => {
    const a = { lamport: 1, senderId: "alice", id: "a" };
    expect(foldComparator(a, a)).toBe(0);
  });

  it("maintains total ordering across multiple items", () => {
    const items = [
      { lamport: 3, senderId: "b", id: "1" },
      { lamport: 1, senderId: "c", id: "2" },
      { lamport: 1, senderId: "a", id: "3" },
      { lamport: 2, senderId: "b", id: "4" },
    ];

    const sorted = [...items].sort(foldComparator);

    expect(sorted[0].lamport).toBe(1);
    expect(sorted[0].senderId).toBe("a");
    expect(sorted[1].lamport).toBe(1);
    expect(sorted[1].senderId).toBe("c");
    expect(sorted[2].lamport).toBe(2);
    expect(sorted[3].lamport).toBe(3);
  });
});

describe("foldUpdate ordering", () => {
  // A reducer where order is visible: it appends every update id it accepts.
  const recorder = {
    manifest: { id: "t" },
    name: "t",
    version: "1",
    initialState: () => [] as string[],
    reduce: (s: unknown, u: { data: unknown }) => [
      ...(s as string[]),
      u.data as string,
    ],
  } as unknown as PluginDefinition;

  const upd = (id: string, lamport: number, ephemeral = false) => ({
    id,
    senderId: "s",
    senderName: "S",
    lamport,
    data: id,
    ephemeral,
    roomCode: "room-1",
  });

  it("folds in-order updates incrementally and advances the entry", () => {
    cardStates.set("c1", { state: ["a"], roomCode: "room-1", pluginId: "t", last: { lamport: 1, senderId: "s", id: "a" } });
    const out = foldUpdate("c1", recorder, upd("b", 2));
    expect(out).toEqual(["a", "b"]);
    expect(cardStates.get("c1")?.last?.lamport).toBe(2);
    cardStates.delete("c1");
  });

  it("evicts on an out-of-order arrival instead of folding on top", () => {
    // Two concurrent spins: lamport 9 arrives AFTER 10 was already folded.
    // Folding it on top applies the wrong order (each client would keep its
    // own winner); the entry must be dropped so storage replays globally.
    cardStates.set("c2", { state: ["ten"], roomCode: "room-1", pluginId: "t", last: { lamport: 10, senderId: "s", id: "ten" } });
    const out = foldUpdate("c2", recorder, upd("nine", 9));
    expect(out).toBeUndefined();
    expect(cardStates.has("c2")).toBe(false);
  });

  it("ephemerals (lamport 0) fold without eviction and never move the cursor", () => {
    cardStates.set("c3", { state: ["a"], roomCode: "room-1", pluginId: "t", last: { lamport: 5, senderId: "s", id: "a" } });
    const out = foldUpdate("c3", recorder, upd("fx", 0, true));
    expect(out).toEqual(["a", "fx"]);
    expect(cardStates.get("c3")?.last?.lamport).toBe(5);
    expect(cardStates.has("c3")).toBe(true);
    cardStates.delete("c3");
  });
});

describe("foldUpdate room binding", () => {
  const recorder = {
    manifest: { id: "t" },
    name: "t",
    version: "1",
    initialState: () => [] as string[],
    reduce: (s: unknown, u: { data: unknown }) => [
      ...(s as string[]),
      u.data as string,
    ],
  } as unknown as PluginDefinition;

  it("refuses an update arriving from a different room than the card's", () => {
    cardStates.set("c4", {
      state: ["a"],
      roomCode: "room-Y",
      pluginId: "t",
      last: { lamport: 1, senderId: "s", id: "a" },
    });
    const out = foldUpdate("c4", recorder, {
      id: "forged",
      senderId: "attacker",
      senderName: "A",
      lamport: 2,
      data: "forged",
      roomCode: "room-X",
    });
    expect(out).toBeUndefined();
    expect(cardStates.get("c4")?.state).toEqual(["a"]);
    expect(cardStates.get("c4")?.last?.lamport).toBe(1);
    cardStates.delete("c4");
  });

  it("clearCardStates(roomCode) leaves other rooms' entries alone", () => {
    cardStates.set("cA", { state: 1, roomCode: "room-A", pluginId: "t", last: null });
    cardStates.set("cB", { state: 2, roomCode: "room-B", pluginId: "t", last: null });
    clearCardStates("room-A");
    expect(cardStates.has("cA")).toBe(false);
    expect(cardStates.get("cB")?.state).toBe(2);
    clearCardStates();
    expect(cardStates.size).toBe(0);
  });
});

describe("card ownership", () => {
  const plugin = (id: string) =>
    ({
      manifest: { id },
      initialState: () => [] as string[],
      reduce: (s: unknown, u: { data: unknown }) => [
        ...(s as string[]),
        u.data as string,
      ],
    }) as unknown as PluginDefinition;

  const row = (
    id: string,
    type: MessageType,
    content: unknown,
    lamport: number
  ) =>
    ({
      id,
      roomCode: "room-1",
      senderId: "s",
      senderName: "S",
      timestamp: lamport,
      lamport,
      type,
      content: JSON.stringify(content),
      attachments: [],
    }) as unknown as Message;

  beforeEach(() => {
    cardStates.clear();
    vi.mocked(getMessagesOfTypes).mockReset();
  });

  it("replays only updates sent by the plugin that owns the card", async () => {
    vi.mocked(getMessagesOfTypes).mockResolvedValue([
      row("card1", MessageType.PluginCard, { pluginId: "poll", data: {} }, 1),
      row(
        "u1",
        MessageType.PluginUpdate,
        { pluginId: "poll", cardId: "card1", data: "good" },
        2
      ),
      // Same cardId, different plugin: the reducer that would run for this
      // one is chosen from ITS pluginId, so folding it here would push a
      // foreign shape through the poll's reducer.
      row(
        "u2",
        MessageType.PluginUpdate,
        { pluginId: "evil", cardId: "card1", data: "forged" },
        3
      ),
    ]);

    const built = await buildCardState("card1", "room-1", plugin("poll"));
    expect(built.state).toEqual(["good"]);
    expect(built.pluginId).toBe("poll");
    expect(built.last?.id).toBe("u1");
  });

  it("refuses a live fold from a plugin that does not own the card", () => {
    cardStates.set("card1", {
      state: ["good"],
      roomCode: "room-1",
      pluginId: "poll",
      last: { lamport: 2, senderId: "s", id: "u1" },
    });
    const out = foldUpdate("card1", plugin("evil"), {
      id: "u2",
      senderId: "attacker",
      senderName: "A",
      lamport: 3,
      data: "forged",
      roomCode: "room-1",
    });
    expect(out).toBeUndefined();
    expect(cardStates.get("card1")?.state).toEqual(["good"]);
    expect(cardStates.get("card1")?.last?.id).toBe("u1");
  });
});

describe("getCardState rebuild loop", () => {
  const plugin = {
    manifest: { id: "poll" },
    initialState: () => [] as string[],
    reduce: (s: unknown, u: { data: unknown }) => [
      ...(s as string[]),
      u.data as string,
    ],
  } as unknown as PluginDefinition;

  const row = (
    id: string,
    type: MessageType,
    content: unknown,
    lamport: number
  ) =>
    ({
      id,
      roomCode: "room-1",
      senderId: "s",
      senderName: "S",
      timestamp: lamport,
      lamport,
      type,
      content: JSON.stringify(content),
      attachments: [],
    }) as unknown as Message;

  beforeEach(() => {
    cardStates.clear();
    vi.mocked(getMessagesOfTypes).mockReset();
  });

  it("stops re-reading storage when updates keep landing mid-build", async () => {
    // Every read is overtaken by another persisted update (like a peer
    // spamming). The retry has to eventually give up to avoid looping
    // forever over the plugin history. With the fix, we discard the stale
    // build rather than installing it, preventing permanent divergence.
    vi.mocked(getMessagesOfTypes).mockImplementation(async () => {
      await Promise.resolve();
      foldUpdate("card1", plugin, {
        id: `u${vi.mocked(getMessagesOfTypes).mock.calls.length}`,
        senderId: "attacker",
        senderName: "A",
        lamport: 99,
        data: "flood",
        roomCode: "room-1",
      });
      return [];
    });

    const state = await getCardState("card1", "room-1", plugin);
    // After exhausting retries, the build is known to be stale and must not
    // be installed. The returned state is undefined (no entry installed).
    expect(state).toBeUndefined();
    expect(cardStates.has("card1")).toBe(false);
    // Still stops after 3 calls (initial + 2 retries), not looping forever.
    expect(vi.mocked(getMessagesOfTypes).mock.calls.length).toBe(3);
  });

  it("does not queue a rebuild for a card nobody is building", async () => {
    // A fold for a card with no entry AND no build in flight has nothing to
    // catch up with: the update was stored before the fold, so the eventual
    // first read already contains it. Flagging it anyway cost a second full
    // room read here, and let a peer grow the flag set with cardIds nobody
    // ever renders.
    foldUpdate("card1", plugin, {
      id: "u1",
      senderId: "attacker",
      senderName: "A",
      lamport: 1,
      data: "flood",
      roomCode: "room-1",
    });

    vi.mocked(getMessagesOfTypes).mockResolvedValue([]);
    await getCardState("card1", "room-1", plugin);
    expect(vi.mocked(getMessagesOfTypes).mock.calls.length).toBe(1);
  });

  it("does not install stale state when updates keep arriving after retries", async () => {
    // Simulate persistent updates arriving during storage reads.
    // For each read up to 2, an update lands that is not yet in storage.
    // This forces retries. After exhausting retry budget, the built state
    // may be stale - the fix must not install it.
    let readCount = 0;
    vi.mocked(getMessagesOfTypes).mockImplementation(async () => {
      // Yield to event loop to allow _building to be set before landing updates.
      await Promise.resolve();
      readCount++;
      const updates: Message[] = [];
      // Accumulate updates in storage: u1 for read 1+, u2 for read 2+, u3 for read 3+
      updates.push(
        row(
          "u1",
          MessageType.PluginUpdate,
          { pluginId: "poll", cardId: "card1", data: "v1" },
          1
        )
      );
      if (readCount >= 2) {
        updates.push(
          row(
            "u2",
            MessageType.PluginUpdate,
            { pluginId: "poll", cardId: "card1", data: "v2" },
            2
          )
        );
      }
      if (readCount >= 3) {
        updates.push(
          row(
            "u3",
            MessageType.PluginUpdate,
            { pluginId: "poll", cardId: "card1", data: "v3" },
            3
          )
        );
      }
      const messages: Message[] = [
        row("card1", MessageType.PluginCard, { pluginId: "poll", data: {} }, 0),
        ...updates,
      ];
      // During reads 1 and 2, land an update that's not yet in storage.
      // This triggers a retry for the next read.
      if (readCount === 1) {
        // During read 1, u2 is not yet in storage, so land it
        foldUpdate("card1", plugin, {
          id: "u2",
          senderId: "s",
          senderName: "S",
          lamport: 2,
          data: "v2",
          roomCode: "room-1",
        });
      } else if (readCount === 2) {
        // During read 2, u3 is not yet in storage, so land it
        foldUpdate("card1", plugin, {
          id: "u3",
          senderId: "s",
          senderName: "S",
          lamport: 3,
          data: "v3",
          roomCode: "room-1",
        });
      }
      // On read 3, no update lands (u3 is now in storage from read 2)
      return messages;
    });

    await getCardState("card1", "room-1", plugin);

    // After the build completes, check how many reads happened.
    // With the retry loop firing on updates landing during reads 1 and 2,
    // we expect at least 2 reads (initial + at least 1 retry).
    expect(readCount).toBeGreaterThanOrEqual(2);

    // After the build completes, check what was installed.
    // The retry loop should ensure that either:
    // 1. No entry is installed (stale build was discarded), or
    // 2. An entry exists with state matching the final read (all u1, u2, u3)
    const entry = cardStates.get("card1");
    if (entry) {
      // If installed, it must have all updates from the final read
      expect(entry.state).toEqual(["v1", "v2", "v3"]);
      expect(entry.last?.id).toBe("u3");
    }
    // If no entry is installed, that's also correct per the invariant.
  });
});
