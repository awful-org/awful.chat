import { DoorOpen, LogIn, LogOut, Link, Pencil, Plus, Trash2, Users } from "@lucide/svelte";
import { roomsStore, renameRoom } from "$lib/rooms.svelte";
import { setRoomName } from "$lib/transport/transport.svelte";
import type { Cmd } from "../types";
import type { CmdSource } from "../host";
import { parseRoomCode } from "../query";

/**
 * Room navigation, joining, and the destructive room-management actions.
 *
 * Rebuilt on every catalog refresh, so every row below reads `roomsStore`
 * and `host` directly rather than caching anything module-scoped.
 */
export const roomCommands: CmdSource = (host) => {
  const cmds: Cmd[] = [];
  const activeCode = host.activeRoomCode;

  // Rooms are ordered by most recent activity so the room you probably want
  // is close to the top even before you type anything.
  const rooms = roomsStore.rooms
    .filter((room) => room.roomCode !== activeCode)
    .slice()
    .sort(
      (a, b) =>
        (roomsStore.lastActivity.get(b.roomCode) ?? 0) -
        (roomsStore.lastActivity.get(a.roomCode) ?? 0)
    );

  for (const room of rooms) {
    const unread = roomsStore.unreadCounts.get(room.roomCode) ?? 0;
    cmds.push({
      id: `room.open:${room.roomCode}`,
      title: room.name || room.roomCode,
      // The room code is shown unconditionally: two rooms can share a name,
      // and the code is the only thing that still tells them apart.
      subtitle: room.roomCode,
      group: "Rooms",
      icon: DoorOpen,
      badge: unread > 0 ? String(unread) : undefined,
      action: { kind: "act", perform: () => host.openRoom(room.roomCode) },
    });
  }

  for (const entry of roomsStore.phonebook) {
    cmds.push({
      id: `room.dm:${entry.peerId}`,
      title: entry.nickname,
      group: "People",
      icon: Users,
      action: { kind: "act", perform: () => host.openDm(entry.peerId) },
    });
  }

  cmds.push({
    id: "room.join",
    title: "Join room by code",
    group: "Rooms",
    icon: LogIn,
    action: {
      kind: "page",
      open: () => ({
        kind: "prompt",
        id: "room.join",
        title: "Join room by code",
        placeholder: "Room code or invite link…",
        validate: (value) =>
          parseRoomCode(value) === null
            ? "Not a room code, invite link, or web+awfl:// link"
            : null,
        submit: (value) => {
          const code = parseRoomCode(value);
          if (code) host.joinRoomByCode(code);
        },
        submitLabel: "Join",
      }),
    },
  });

  cmds.push({
    id: "room.create",
    title: "Create or join a room",
    group: "Rooms",
    icon: Plus,
    action: { kind: "act", perform: () => host.openCreateJoin() },
  });

  if (activeCode) {
    cmds.push({
      id: "room.copyLink",
      title: "Copy room link",
      group: "Rooms",
      icon: Link,
      action: {
        kind: "act",
        perform: () => {
          const url = `${window.location.origin}/r/${activeCode}`;
          navigator.clipboard
            .writeText(url)
            .catch((err) => console.warn("copy room link failed", err));
        },
      },
    });

    const current = roomsStore.rooms.find((r) => r.roomCode === activeCode);
    const currentTitle = current ? current.name || activeCode : activeCode;
    cmds.push({
      id: "room.rename",
      title: "Rename room",
      group: "Rooms",
      icon: Pencil,
      action: {
        kind: "page",
        open: () => ({
          kind: "prompt",
          id: "room.rename",
          title: "Rename room",
          initial: currentTitle,
          // Without this an empty submit would blank the room name for every
          // participant, since `setRoomName` broadcasts whatever it is given.
          validate: (value) =>
            value.trim().length === 0 ? "Room name cannot be empty" : null,
          submit: async (value) => {
            try {
              await renameRoom(activeCode, value);
              setRoomName(value);
            } catch (err) {
              console.warn("rename room failed", err);
            }
          },
          submitLabel: "Rename",
        }),
      },
    });

    cmds.push({
      id: "room.leave",
      title: "Leave room",
      group: "Rooms",
      icon: LogOut,
      action: { kind: "act", perform: () => host.leaveRoom() },
    });

    cmds.push({
      id: "room.remove",
      title: "Remove room",
      group: "Rooms",
      icon: Trash2,
      danger: true,
      action: {
        kind: "page",
        open: () => ({
          kind: "confirm",
          id: "room.remove",
          title: "Remove room",
          message: `Remove "${currentTitle}" and its history? This cannot be undone.`,
          confirmLabel: "Remove",
          confirm: () => host.removeRoom(activeCode),
        }),
      },
    });
  }

  return cmds;
};
