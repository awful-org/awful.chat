import type { Room } from "./storage";

export interface ConversationMetric {
  roomCode: string;
  name: string;
  messageCount: number;
}

export function conversationMetrics(
  conversations: Pick<Room, "roomCode" | "name" | "type">[],
  counts: ReadonlyMap<string, number>
) {
  const rooms: ConversationMetric[] = [];
  const dms: ConversationMetric[] = [];
  for (const room of conversations) {
    (room.type === "dm" ? dms : rooms).push({
      roomCode: room.roomCode,
      name: room.name || room.roomCode,
      messageCount: counts.get(room.roomCode) ?? 0,
    });
  }
  const top = (items: ConversationMetric[]) =>
    items.sort((a, b) => b.messageCount - a.messageCount).slice(0, 5);
  return {
    totalRooms: rooms.length,
    totalDMs: dms.length,
    rooms: top(rooms),
    dms: top(dms),
  };
}
