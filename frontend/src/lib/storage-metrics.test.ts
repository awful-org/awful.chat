import { expect, it } from "vitest";
import { conversationMetrics } from "./storage-metrics";

it("partitions by type before taking the top five, even when every DM outranks a room", () => {
  const dms = Array.from({ length: 7 }, (_, i) => ({ roomCode: `dm-${i}`, name: `Friend ${i}`, type: "dm" as const }));
  const rooms = [{ roomCode: "room", name: "dm-looking room name", type: "text" as const }];
  const counts = new Map([...dms.map((dm, i) => [dm.roomCode, 100 + i] as const), ["room", 2] as const]);
  const result = conversationMetrics([...rooms, ...dms], counts);
  expect(result.totalRooms).toBe(1);
  expect(result.totalDMs).toBe(7);
  expect(result.rooms).toEqual([{ roomCode: "room", name: "dm-looking room name", messageCount: 2 }]);
  expect(result.dms).toHaveLength(5);
  expect(result.dms[0].roomCode).toBe("dm-6");
});
