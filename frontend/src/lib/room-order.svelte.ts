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

/** The sidebar's full room order after a drag or keyboard move. */
export function setRoomOrder(order: string[]): void {
  roomOrderStore.order = order;
  try {
    localStorage.setItem(ROOM_ORDER_KEY, JSON.stringify(order));
  } catch {
    // Storage blocked: the order just does not survive a reload.
  }
}
