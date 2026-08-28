import type { Cmd } from "./types";

/**
 * The slice of app behaviour the palette cannot reach on its own.
 *
 * Room navigation lives in `AppView`: it owns `activeRoomCode`, pushes history,
 * persists the room, and broadcasts the room name. Reproducing that in the
 * palette would fork the join path, so the palette asks its host instead.
 *
 * Read-only fields are declared as getters by the implementor so that reads stay
 * reactive across the boundary.
 */
export interface PaletteHost {
  /** The room on screen, or `null` when none is open. */
  readonly activeRoomCode: string | null;

  /** Switch to an already-known room. A view change, not a rejoin. */
  openRoom(roomCode: string): void;

  /**
   * Join a room by code, adding it to the room list.
   * Rejects codes that are not six lowercase hex characters.
   */
  joinRoomByCode(roomCode: string): void;

  /** Open a direct-message conversation with a phonebook peer. */
  openDm(peerId: string): void;

  /** Close the room on screen. Keeps it in the room list. */
  leaveRoom(): void;

  /** Remove a room and its history. Destructive. */
  removeRoom(roomCode: string): void;

  /** Open the existing create-or-join dialog. */
  openCreateJoin(): void;
}

/**
 * A group of commands contributed by one area of the app.
 *
 * Called on every catalog rebuild, so it must read reactive state directly and
 * must not cache. It is *not* called per keystroke: the catalog depends on app
 * state, not on the query.
 */
export type CmdSource = (host: PaletteHost) => Cmd[];
