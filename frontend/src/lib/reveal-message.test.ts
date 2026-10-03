import { beforeEach, expect, it, vi } from "vitest";

const s = vi.hoisted(() => ({
  state: {
    roomCode: "room-a" as string | null,
    messages: [] as { id: string; lamport: number; roomCode: string }[],
  },
  stored: new Map<string, { id: string; lamport: number; roomCode: string }>(),
  read: null as Promise<unknown> | null,
  loadMore: vi.fn(async (..._args: unknown[]) => true),
  jump: vi.fn(),
}));
vi.mock("$lib/transport/transport.svelte", () => ({
  transportState: s.state,
  loadMoreMessages: s.loadMore,
}));
vi.mock("$lib/ui-state.svelte", () => ({ requestJumpToMessage: s.jump }));
vi.mock("$lib/storage", () => ({
  getMessage: async (id: string) => {
    await s.read;
    return s.stored.get(id);
  },
}));

import { revealInFlight, revealMessage, revealStored } from "./reveal-message";

function row(lamport: number, roomCode = "room-a") {
  return { id: `m${lamport}`, lamport, roomCode };
}

beforeEach(() => {
  vi.clearAllMocks();
  s.state.roomCode = "room-a";
  s.state.messages = [row(500), row(501)];
  s.stored.clear();
  s.read = null;
});

// A quote, or a plugin card's way back to itself, naming a message the view
// had let go of: the jump did nothing.
it("reads a message the view does not hold from storage, and reveals it", async () => {
  s.stored.set("m30", row(30));
  await revealStored("room-a", "m30");
  expect(s.loadMore).toHaveBeenCalledWith(s.state.messages[0], {
    to: { lamport: 30, id: "m30" },
    pages: 40,
  });
  expect(s.jump).toHaveBeenCalledWith("room-a", "m30", true);
});

it("goes nowhere for a message of another conversation, or one not stored", async () => {
  s.stored.set("m30", row(30, "room-b"));
  await revealStored("room-a", "m30");
  await revealStored("room-a", "m-unknown");
  expect(s.loadMore).not.toHaveBeenCalled();
  expect(s.jump).not.toHaveBeenCalled();
});

it("keeps the rows the view holds while storage is read", async () => {
  let finish!: () => void;
  s.read = new Promise<void>((resolve) => (finish = resolve));
  s.stored.set("m30", row(30));
  const revealing = revealStored("room-a", "m30");
  expect(revealInFlight()).toBe(true);
  finish();
  await revealing;
  expect(revealInFlight()).toBe(false);
});

// The jump a reveal ends with says so, and ChatView does not read storage
// for it again when the row is still not one it shows (planJump).
it("marks the jump it ends with as revealed", async () => {
  await revealMessage("room-a", "m501", 501);
  expect(s.loadMore).not.toHaveBeenCalled();
  expect(s.jump).toHaveBeenCalledWith("room-a", "m501", true);
});
