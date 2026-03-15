import { getAllRooms, putRoom, deleteRoom, getUnreadCount, type Room } from "./storage";

interface RoomsStore {
  rooms: Room[];
  loading: boolean;
  unreadCounts: Map<string, number>;
}

export const roomsStore = $state<RoomsStore>({
  rooms: [],
  loading: false,
  unreadCounts: new Map(),
});

export async function loadRooms(): Promise<void> {
  roomsStore.loading = true;
  try {
    const all = await getAllRooms();
    roomsStore.rooms = all.filter((r) => r.type !== "dm") as Room[];
    await _refreshAllUnread();
  } finally {
    roomsStore.loading = false;
  }
}

export async function refreshUnreadCount(roomCode: string): Promise<void> {
  const room = roomsStore.rooms.find((r) => r.roomCode === roomCode);
  if (!room) return;
  const count = await getUnreadCount(roomCode, room.lastSeenLamport);
  const next = new Map(roomsStore.unreadCounts);
  next.set(roomCode, count);
  roomsStore.unreadCounts = next;
}

async function _refreshAllUnread(): Promise<void> {
  const entries = await Promise.all(
    roomsStore.rooms.map(async (r) => {
      const count = await getUnreadCount(r.roomCode, r.lastSeenLamport);
      return [r.roomCode, count] as [string, number];
    }),
  );
  roomsStore.unreadCounts = new Map(entries);
}

export async function saveRoom(roomCode: string, name: string): Promise<void> {
  const existing = roomsStore.rooms.find((r) => r.roomCode === roomCode);
  if (existing) return;

  const room: Room = {
    roomCode,
    name,
    type: "text",
    lastSeenLamport: 0,
    createdAt: Date.now(),
  };

  await putRoom(room);
  roomsStore.rooms = [...roomsStore.rooms, room];
}

export async function removeRoom(roomCode: string): Promise<void> {
  await deleteRoom(roomCode);
  roomsStore.rooms = roomsStore.rooms.filter((r) => r.roomCode !== roomCode);
  const next = new Map(roomsStore.unreadCounts);
  next.delete(roomCode);
  roomsStore.unreadCounts = next;
}
