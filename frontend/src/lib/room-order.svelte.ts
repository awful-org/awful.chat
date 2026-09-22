import { moveRoomBefore } from "./room-order";
import type { Room } from "./storage";

const ROOM_ORDER_KEY = "awful:room-order:v1";

function readOrder(): string[] {
  if (typeof localStorage === "undefined") return [];
  try {
    const raw = localStorage.getItem(ROOM_ORDER_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((code): code is string => typeof code === "string")
      : [];
  } catch {
    return [];
  }
}

export const roomOrderStore = $state({ order: readOrder() });

/** Drag `fromCode`'s row to sit just before `toCode`'s in the sidebar. */
export function reorderRoom(rooms: Room[], fromCode: string, toCode: string): void {
  const next = moveRoomBefore(rooms, roomOrderStore.order, fromCode, toCode);
  roomOrderStore.order = next;
  try {
    localStorage.setItem(ROOM_ORDER_KEY, JSON.stringify(next));
  } catch {
    // Storage blocked: the order just does not survive a reload.
  }
}
