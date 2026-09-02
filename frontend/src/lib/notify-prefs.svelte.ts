import { hashRef } from "./storage-crypto";

/**
 * notify-prefs.svelte.ts - how loud each conversation is allowed to be.
 *
 * "all" is the default and is never written: only the rooms someone has
 * actually turned down take up space, so this map stays the size of the
 * decisions made rather than the size of the room list.
 *
 * Keyed by hashRef(roomCode), NOT by the code. localStorage is plaintext on
 * disk and survives a lock, and the room code IS the room's entire membership
 * secret - the same reason announce.ts puts an opaque ref in a notification
 * rather than the code. A hash is enough to look a preference up, and gives
 * nothing away to whoever reads the file.
 */

export type RoomNotifyMode = "all" | "mentions" | "muted";

const KEY = "awful:room-notify:v1";

function isMode(v: unknown): v is RoomNotifyMode {
  return v === "all" || v === "mentions" || v === "muted";
}

function load(): Record<string, RoomNotifyMode> {
  if (typeof localStorage === "undefined") return {};
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "{}") as unknown;
    if (!raw || typeof raw !== "object") return {};
    const out: Record<string, RoomNotifyMode> = {};
    for (const [ref, mode] of Object.entries(raw)) {
      if (isMode(mode) && mode !== "all") out[ref] = mode;
    }
    return out;
  } catch {
    return {};
  }
}

// A rune-backed object, so a component that reads getRoomNotifyMode() in a
// $derived repaints when the mode is changed from a menu somewhere else.
const prefs = $state<{ modes: Record<string, RoomNotifyMode> }>({
  modes: load(),
});

export function getRoomNotifyMode(roomCode: string): RoomNotifyMode {
  return prefs.modes[hashRef(roomCode)] ?? "all";
}

export function setRoomNotifyMode(roomCode: string, mode: RoomNotifyMode): void {
  const ref = hashRef(roomCode);
  if (mode === "all") delete prefs.modes[ref];
  else prefs.modes[ref] = mode;
  try {
    localStorage.setItem(KEY, JSON.stringify(prefs.modes));
  } catch {
    // Storage blocked: the choice just does not survive a reload.
  }
}

// A second tab muting a room should be reflected here, not fought.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key === KEY) prefs.modes = load();
  });
}
