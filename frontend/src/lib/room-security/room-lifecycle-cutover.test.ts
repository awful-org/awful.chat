import { expect, it, vi } from "vitest";
vi.mock("./invitation-release", () => ({ ROOM_SECURITY_V2_RELEASED: true }));
import { joinStoredRoom } from "./room-lifecycle";
import { acceptsRoomScope } from "./scope";
import { LibP2PTransport } from "../transport/libp2p/transport";

it("rejects legacy restore, join, send, broadcast and SFU admission after cutover", async () => {
  const t = new LibP2PTransport();
  expect(() => joinStoredRoom(t, "OLDROOM")).toThrow("read-only");
  expect(() => t.joinRoom("OLDROOM")).toThrow("read-only");
  const raw = vi.spyOn(t, "send");
  expect(await t.sendRoom("peer", "OLDROOM", new Uint8Array([1]))).toBe(false);
  await t.broadcast(new Uint8Array([1]), "OLDROOM");
  expect(raw).not.toHaveBeenCalled();
  expect(() => t.sfuAdmission("OLDROOM", "nonce", "peer")).toThrow("read-only");
});

it("rejects legacy receive scopes while retaining authenticated DM aliases", () => {
  expect(acceptsRoomScope({ roomCode: "OLDROOM" }, null)).toBe(false);
  expect(acceptsRoomScope({}, "OLDROOM")).toBe(false);
  expect(acceptsRoomScope({ roomCode: "dm-local" }, "dm-local")).toBe(true);
  expect(acceptsRoomScope({ roomCode: "dm-local" }, null)).toBe(false);
});
