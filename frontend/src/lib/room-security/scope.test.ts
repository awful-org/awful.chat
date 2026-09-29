import { beforeEach, expect, it, vi } from "vitest";
const release = vi.hoisted(() => ({ enabled: true }));
vi.mock("./invitation-release", () => ({
  get ROOM_SECURITY_V2_RELEASED() { return release.enabled; },
}));
import { acceptsRoomScope } from "./scope";
beforeEach(() => { release.enabled = true; });

it("rejects plaintext downgrade and cross-room claims before dispatch", () => {
  expect(acceptsRoomScope({ roomCode: "rd2_a" }, null)).toBe(false);
  expect(acceptsRoomScope({ roomCode: "rd2_a" }, "legacy")).toBe(false);
  expect(acceptsRoomScope({ roomCode: "rd2_a" }, "rd2_b")).toBe(false);
  expect(acceptsRoomScope({ roomCode: "legacy" }, "rd2_a")).toBe(false);
  expect(acceptsRoomScope({ roomCode: null }, "rd2_a")).toBe(false);
  expect(acceptsRoomScope({ roomCode: "r2_secret" }, null)).toBe(false);
});

it("admits matching protected context and unscoped profile introductions after release", () => {
  expect(acceptsRoomScope({ roomCode: "rd2_a" }, "rd2_a")).toBe(true);
  expect(acceptsRoomScope({ type: "profile" }, "rd2_a")).toBe(true);
  expect(acceptsRoomScope({ roomCode: "legacy" }, null)).toBe(false);
  expect(acceptsRoomScope({ roomCode: "legacy" }, "legacy")).toBe(false);
  expect(acceptsRoomScope({ type: "profile" }, "legacy")).toBe(false);
  expect(acceptsRoomScope({ roomCode: "dm-a" }, "dm-a")).toBe(true);
  expect(acceptsRoomScope({ roomCode: "dm-a" }, null)).toBe(false);
  expect(acceptsRoomScope({ type: "profile" }, null)).toBe(true);
  expect(acceptsRoomScope(null, "rd2_a")).toBe(false);
});

it("leaves legacy schema checks to existing handlers only before cutover", () => {
  release.enabled = false; // Explicit legacy-only coverage.
  expect(acceptsRoomScope({ roomCode: "legacy" }, null)).toBe(true);
  expect(acceptsRoomScope({ roomCode: "legacy" }, "legacy")).toBe(true);
  expect(acceptsRoomScope({ roomCode: "rd2_a" }, null)).toBe(false);
});
