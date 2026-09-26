import {
  AtSign,
  Bell,
  BellOff,
  DoorOpen,
  KeyRound,
  LogIn,
  Link,
  Pencil,
  Pin,
  PinOff,
  Plus,
  Share2,
  Trash2,
  Users,
} from "@lucide/svelte";
import { roomsStore, renameRoom, toggleRoomPin } from "$lib/rooms.svelte";
import { createInvite, formatShortCode } from "$lib/invite";
import {
  getRoomNotifyMode,
  setRoomNotifyMode,
  type RoomNotifyMode,
} from "$lib/notify-prefs.svelte";
import { hashRef } from "$lib/storage-crypto";
import { setRoomName } from "$lib/transport/transport.svelte";
import type { Cmd } from "../types";
import type { CmdSource } from "../host";
import { parseRoomCode } from "../query";

const NOTIFY_LABEL: Record<RoomNotifyMode, string> = {
  all: "All messages",
  mentions: "Mentions only",
  muted: "Off",
};

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
      // Hashed, because a command id is not just an id: the MRU persists the
      // ids you used to localStorage (mru.ts), so a plaintext one wrote the
      // room code - the room's whole membership secret - into web storage,
      // where it survives every lock and outlives the room. The real code
      // stays in the closure below, which is the only place that needs it.
      id: `room.open:${hashRef(room.roomCode)}`,
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
      // Hashed for the same reason as room.open above: the peer id is the
      // social graph, and the MRU would persist it verbatim.
      id: `room.dm:${hashRef(entry.peerId)}`,
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
          // Fragment form - see RoomCreateJoin's handleCopy.
          const url = `${window.location.origin}/r/#${activeCode}`;
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

    // The header's invite menu, minus nothing: the 5-minute short code for
    // typing on a phone, and the OS share sheet where the browser has one.
    cmds.push({
      id: "room.copyShortCode",
      title: "Copy short invite code",
      subtitle: "Works for 5 minutes",
      keywords: ["invite", "code", "share"],
      group: "Rooms",
      icon: KeyRound,
      action: {
        kind: "act",
        perform: async () => {
          try {
            const { code } = await createInvite(activeCode);
            await navigator.clipboard.writeText(formatShortCode(code));
          } catch (err) {
            console.warn("copy short invite code failed", err);
          }
        },
      },
    });
    if (typeof navigator !== "undefined" && typeof navigator.share === "function") {
      cmds.push({
        id: "room.shareLink",
        title: "Share room link",
        keywords: ["invite", "send"],
        group: "Rooms",
        icon: Share2,
        action: {
          kind: "act",
          perform: () => {
            navigator
              .share({ url: `${window.location.origin}/r/#${activeCode}` })
              .catch(() => {});
          },
        },
      });
    }

    const pinned = current?.pinnedAt != null;
    cmds.push({
      id: "room.pin",
      title: pinned ? "Unpin room" : "Pin room to top",
      keywords: ["pin", "favorite", "top", "sidebar"],
      group: "Rooms",
      icon: pinned ? PinOff : Pin,
      action: { kind: "act", perform: () => void toggleRoomPin(activeCode) },
    });

    const mode = getRoomNotifyMode(activeCode);
    cmds.push({
      id: "room.notify",
      title: "Room notifications",
      keywords: ["mute", "mentions", "notify", "bell", "quiet"],
      group: "Rooms",
      icon: mode === "muted" ? BellOff : mode === "mentions" ? AtSign : Bell,
      badge: NOTIFY_LABEL[mode],
      action: {
        kind: "page",
        open: () => ({
          kind: "list",
          id: "room.notify",
          title: "Room notifications",
          items: () =>
            (["all", "mentions", "muted"] as const).map((m) => ({
              id: `room.notify:${m}`,
              title: NOTIFY_LABEL[m],
              group: "Notify me about",
              icon: m === "muted" ? BellOff : m === "mentions" ? AtSign : Bell,
              badge: m === mode ? "Current" : undefined,
              action: {
                kind: "act" as const,
                perform: () => setRoomNotifyMode(activeCode, m),
              },
            })),
        }),
      },
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
