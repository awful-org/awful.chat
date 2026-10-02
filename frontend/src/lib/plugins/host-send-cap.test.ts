import { beforeEach, expect, it, vi } from "vitest";
import { CARD_FLOOD_LIMIT, UPDATE_FLOOD_LIMIT } from "./flood-cap";

const t = vi.hoisted(() => ({
  sendCard: vi.fn(async () => "card-id"),
  sendUpdate: vi.fn(async () => {}),
  sendUpdateImmediately: vi.fn(),
}));
vi.mock("$lib/transport/transport.svelte", () => ({
  ...t,
  transportState: { roomCode: "room-a", fileTransfers: new Map() },
  onBeforeDisconnect: vi.fn(),
}));
vi.mock("$lib/identity/identity.svelte", () => ({ identityStore: { did: "did:key:zMe" } }));
vi.mock("$lib/identity/identity", () => { const session = {}; return { requireSession: () => session }; });
vi.mock("$lib/storage", () => ({}));
vi.mock("$lib/ui-state.svelte", () => ({}));
vi.mock("./media-session", () => ({}));
vi.mock("./state.svelte", () => ({}));
vi.mock("./local-cards.svelte", () => ({ closeLocalCard: vi.fn() }));
vi.mock("$lib/transport/voice.svelte", () => ({
  getCallAudioBlockedReason: vi.fn(), getCallCaptureBlockedReason: vi.fn(),
  getCallCaptureStreams: vi.fn(), onCallCaptureChange: vi.fn(),
}));
vi.mock("$lib/audio/call-audio-mixer", () => ({ CALL_SOUND_MAX_DURATION_MS: 1000 }));

import { makeHostApi } from "./host";

beforeEach(() => vi.clearAllMocks());

// Receivers drop a sender's cards and persisted updates past a per-room cap,
// without a word. Nothing kept an honest client under it, so it could post
// what everyone else then dropped - while keeping its own copy.
it("refuses a card past the cap instead of sending what receivers would drop", async () => {
  const host = makeHostApi("poll", "room-cards");
  for (let i = 0; i < CARD_FLOOD_LIMIT; i++) await host.sendCard({ i });
  await expect(host.sendCard({ i: "over" })).rejects.toThrow(/^Too many cards at once\. Try again in \d+ seconds?\.$/);
  expect(t.sendCard).toHaveBeenCalledTimes(CARD_FLOOD_LIMIT);
  // The cap is the room's and the sender's, every plugin together.
  await expect(makeHostApi("wheel", "room-cards").sendCard({})).rejects.toThrow(/Too many cards/);
  await makeHostApi("poll", "room-other").sendCard({});
  expect(t.sendCard).toHaveBeenCalledTimes(CARD_FLOOD_LIMIT + 1);
});

it("gives the slot back when a send fails before it goes out", async () => {
  const host = makeHostApi("poll", "room-failing");
  t.sendCard.mockRejectedValueOnce(new Error("Not in a room"));
  await expect(host.sendCard({})).rejects.toThrow("Not in a room");
  for (let i = 0; i < CARD_FLOOD_LIMIT; i++) await host.sendCard({ i });
  await expect(host.sendCard({})).rejects.toThrow(/Too many cards/);
});

it("holds persisted updates to the room's cap, ephemerals apart, beacons included", async () => {
  const poll = makeHostApi("poll", "room-updates");
  const wheel = makeHostApi("wheel", "room-updates");
  for (let i = 0; i < UPDATE_FLOOD_LIMIT; i++) {
    await (i % 2 ? poll : wheel).sendUpdate("card", { i });
  }
  await expect(poll.sendUpdate("card", { i: "over" })).rejects.toThrow(/Too many updates at once/);
  expect(t.sendUpdate).toHaveBeenCalledTimes(UPDATE_FLOOD_LIMIT);
  // Ephemerals have their own cap in the transport; this one does not touch them.
  await poll.sendUpdate("card", { cursor: 1 }, { ephemeral: true });
  expect(t.sendUpdate).toHaveBeenCalledTimes(UPDATE_FLOOD_LIMIT + 1);
  // The teardown beacon is a persisted update too: past the cap, not sent.
  poll.sendUpdateImmediately("card", { t: "leave" });
  expect(t.sendUpdateImmediately).not.toHaveBeenCalled();
  makeHostApi("poll", "room-quiet").sendUpdateImmediately("card", { t: "leave" });
  expect(t.sendUpdateImmediately).toHaveBeenCalledExactlyOnceWith("poll", "card", { t: "leave" }, "room-quiet");
});
