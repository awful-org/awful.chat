import { afterEach, describe, expect, it, vi } from "vitest";

// Counts the hashes and still returns the real ones, so the ids under test
// are exactly the ids the MRU has always stored.
const hashRef = vi.hoisted(() => vi.fn<(value: string) => string>());
vi.mock("$lib/storage-crypto", async (importOriginal) => {
  const real = await importOriginal<typeof import("$lib/storage-crypto")>();
  hashRef.mockImplementation(real.hashRef);
  return { ...real, hashRef };
});
// The rename row closes over this; building the catalog never calls it, and
// the real module boots the whole transport.
vi.mock("$lib/transport/transport.svelte", () => ({
  renameRoomEverywhere: vi.fn(),
}));

import { forgetRoomRefs, roomCommands } from "./rooms";
import { roomsStore } from "$lib/rooms.svelte";
import { hashRef as realHashRef } from "$lib/storage-crypto";
import type { PaletteHost } from "../host";
import type { PhonebookEntry, Room } from "$lib/storage";

const host: PaletteHost = {
  activeRoomCode: null,
  openRoom: () => {},
  joinRoomByCode: () => {},
  openDm: () => {},
  removeRoom: () => {},
  openCreateJoin: () => {},
};

function room(roomCode: string, name: string): Room {
  return {
    roomCode,
    type: "text",
    name,
    lastSeenLamport: 0,
    createdAt: 0,
    participants: [],
  };
}

function contact(peerId: string, nickname: string): PhonebookEntry {
  return { peerId, nickname, addedAt: 0 };
}

function hashesOf(value: string): number {
  return hashRef.mock.calls.filter(([v]) => v === value).length;
}

afterEach(() => {
  forgetRoomRefs();
  hashRef.mockClear();
  roomsStore.rooms = [];
  roomsStore.phonebook = [];
});

describe("room and contact command ids", () => {
  it("hashes each room code and peer id once, however often the catalog is built", () => {
    roomsStore.rooms = [room("rd2_alpha", "Alpha"), room("rd2_beta", "Beta")];
    roomsStore.phonebook = [contact("12D3KooWpeer", "Bob")];

    // The palette used to rebuild on every unread count and activity change:
    // each build paid a pure-JS SHA-256 per room and per contact again.
    const first = roomCommands(host).map((cmd) => cmd.id);
    roomCommands(host);
    const third = roomCommands(host).map((cmd) => cmd.id);

    expect(hashesOf("rd2_alpha")).toBe(1);
    expect(hashesOf("rd2_beta")).toBe(1);
    expect(hashesOf("12D3KooWpeer")).toBe(1);
    expect(third).toEqual(first);
  });

  it("keeps the ids the recency list already stored", () => {
    roomsStore.rooms = [room("rd2_alpha", "Alpha")];
    roomsStore.phonebook = [contact("12D3KooWpeer", "Bob")];

    const ids = roomCommands(host).map((cmd) => cmd.id);

    // Memoizing must not change a single id: the MRU in localStorage holds
    // these, and a different one would silently drop the user's recents.
    expect(ids).toContain(`room.open:${realHashRef("rd2_alpha")}`);
    expect(ids).toContain(`room.dm:${realHashRef("12D3KooWpeer")}`);
  });

  it("forgets every ref when the palette goes away", () => {
    roomsStore.rooms = [room("rd2_alpha", "Alpha")];
    roomCommands(host);
    expect(hashesOf("rd2_alpha")).toBe(1);

    // A lock unmounts the palette, and the refs are keyed by room code: they
    // must not outlive the session.
    forgetRoomRefs();
    roomCommands(host);

    expect(hashesOf("rd2_alpha")).toBe(2);
  });
});
