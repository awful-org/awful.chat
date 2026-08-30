import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  cardsForRoom,
  clearLocalCards,
  closeLocalCard,
  localPluginCards,
  upsertLocalCard,
} from "./local-cards.svelte";

describe("local plugin cards", () => {
  beforeEach(() => {
    clearLocalCards();
    vi.restoreAllMocks();
  });

  it("upserts one card per plugin and room", () => {
    vi.spyOn(Date, "now").mockReturnValueOnce(10).mockReturnValueOnce(20);
    const first = upsertLocalCard("soundboard", "room-a", { open: 1 });
    const second = upsertLocalCard("soundboard", "room-a", { open: 2 });

    expect(second.id).toBe(first.id);
    expect(cardsForRoom("room-a")).toEqual([second]);
    expect(second.data).toEqual({ open: 2 });
    expect(second.createdAt).toBe(20);
  });

  it("isolates cards by room and closes only the requested card", () => {
    const roomA = upsertLocalCard("soundboard", "room-a", undefined);
    const roomB = upsertLocalCard("soundboard", "room-b", undefined);

    closeLocalCard(roomA.id);

    expect(cardsForRoom("room-a")).toEqual([]);
    expect(cardsForRoom("room-b")).toEqual([roomB]);
  });

  it("clears every session-only entry", () => {
    upsertLocalCard("soundboard", "room-a", undefined);
    upsertLocalCard("poll", "room-a", undefined);

    clearLocalCards();

    expect(localPluginCards.entries).toEqual([]);
  });
});
