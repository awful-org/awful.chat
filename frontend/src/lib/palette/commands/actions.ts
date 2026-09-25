import {
  Camera,
  CameraOff,
  CornerUpLeft,
  Download,
  HardDrive,
  Headphones,
  Keyboard,
  HeadphoneOff,
  Lock,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  Phone,
  PhoneOff,
  PictureInPicture2,
  Pin,
  RefreshCw,
  Search,
  Trash2,
  Upload,
  Users,
  Video,
} from "@lucide/svelte";
import { openSearch } from "$lib/search/ui.svelte";
import {
  transportState,
  connect,
  peerIdToDid,
} from "$lib/transport/transport.svelte";
import {
  stopWatchingTransmission,
  watchTransmission,
} from "$lib/transport/transmission.svelte";
import { callPipPanel } from "$lib/call-pip.svelte";
import {
  browserPipSupported,
  enterBrowserPip,
  exitBrowserPip,
  spotlightStore,
} from "$lib/call-spotlight.svelte";
import {
  joinCall,
  leaveCall,
  stopScreenShare,
  cameraOnPressed,
  toggleDeafen,
  toggleMute,
} from "$lib/transport/call.svelte";
import { lock } from "$lib/identity/identity.svelte";
import { requestPersistentStorage, wipeLocalDatabase } from "$lib/storage";
import {
  openSettings,
  openSharePicker,
  requestReturnToCall,
  togglePinnedMessages,
  toggleUserList,
  uiState,
} from "$lib/ui-state.svelte";
import { pinnedMessagesOf } from "$lib/rooms.svelte";
import { useQc, useQs } from "$lib/runtime-config";
import type { Cmd } from "../types";
import type { CmdSource } from "../host";
import { shortcutRows } from "../shortcuts";

function peerName(peerId: string): string {
  const did = peerIdToDid(peerId);
  return (
    (did && transportState.peerNames.get(did)) ||
    transportState.peerNames.get(peerId) ||
    peerId.slice(0, 8)
  );
}

/**
 * Call controls plus app-wide actions (reconnect, lock, storage, backup,
 * and the destructive data wipe).
 *
 * The in-call rows (mute, deafen, camera, screen share) only make sense
 * once a call exists, so they are omitted entirely outside a call rather
 * than shown disabled.
 */
export const actionCommands: CmdSource = () => {
  const cmds: Cmd[] = [];

  // Split to match the shortcuts: this listed Ctrl+F, which searches the open
  // room, while it searched every room - which is Ctrl+Shift+F.
  if (transportState.roomCode) {
    const here = transportState.roomCode;
    cmds.push({
      id: "action.searchRoom",
      title: "Search this room",
      keywords: ["find", "history", "grep", "messages"],
      group: "Actions",
      icon: Search,
      shortcut: ["Ctrl", "F"],
      action: { kind: "act", perform: () => openSearch(here) },
    });
  }
  cmds.push({
    id: "action.searchMessages",
    title: "Search all rooms",
    keywords: ["find", "history", "grep", "messages", "everywhere"],
    group: "Actions",
    icon: Search,
    shortcut: ["Ctrl", "Shift", "F"],
    action: { kind: "act", perform: () => openSearch(null) },
  });

  // Only where the list exists: a DM has two people and no roster, and the
  // landing screen has no room. Omitted rather than disabled, like the
  // in-call rows.
  if (transportState.roomCode && transportState.chatMode === "room") {
    cmds.push({
      id: "actions.userList.toggle",
      title: uiState.userListOpen ? "Hide users" : "Show users",
      keywords: ["members", "user list", "sidebar", "people", "roster", "who"],
      group: "Actions",
      icon: Users,
      badge: uiState.userListOpen ? "On" : "Off",
      action: { kind: "act", perform: () => toggleUserList() },
    });
  }

  // Rooms and DMs both keep pins; the landing screen has none to show.
  if (transportState.roomCode) {
    const count = pinnedMessagesOf(transportState.roomCode).length;
    cmds.push({
      id: "actions.pinned.toggle",
      title: uiState.pinnedOpen ? "Hide pinned messages" : "Show pinned messages",
      keywords: ["pins", "pinned", "saved", "bookmarks"],
      group: "Actions",
      icon: Pin,
      badge: count > 0 ? String(count) : undefined,
      action: { kind: "act", perform: () => togglePinnedMessages() },
    });
  }

  // The pages that need no account, when this instance serves them. A real
  // navigation rather than a router push: they run their own transport and
  // their own storage scope, and both of those are decided before the app
  // mounts. Opened in a new tab so whatever is going on here survives.
  if (useQs()) {
    cmds.push({
      id: "actions.quickSend",
      title: "Quick send a file",
      subtitle: "No account, straight to them, nothing kept",
      keywords: ["qs", "share", "transfer", "upload", "guest"],
      group: "Actions",
      icon: Upload,
      action: {
        kind: "act",
        perform: () => {
          window.open("/qs", "_blank", "noopener");
        },
      },
    });
  }

  if (useQc()) {
    cmds.push({
      id: "actions.quickCall",
      title: "Quick call",
      subtitle: "A call with no room, nothing kept",
      keywords: ["qc", "meet", "guest", "video", "link"],
      group: "Actions",
      icon: Video,
      action: {
        kind: "act",
        perform: () => {
          window.open("/qc", "_blank", "noopener");
        },
      },
    });
  }

  cmds.push({
    id: "actions.call.toggle",
    title: transportState.inCall ? "Leave call" : "Join call",
    group: "Call",
    icon: transportState.inCall ? PhoneOff : Phone,
    action: {
      kind: "act",
      perform: transportState.inCall
        ? () => leaveCall()
        : () => {
            joinCall().catch((err) => console.warn("join call failed", err));
          },
    },
  });

  if (transportState.inCall) {
    cmds.push({
      id: "actions.call.mute",
      title: transportState.muted ? "Unmute microphone" : "Mute microphone",
      group: "Call",
      icon: transportState.muted ? MicOff : Mic,
      badge: transportState.muted ? "Muted" : "Live",
      action: { kind: "act", keepOpen: true, perform: () => toggleMute() },
    });

    cmds.push({
      id: "actions.call.deafen",
      title: transportState.deafened ? "Undeafen" : "Deafen",
      group: "Call",
      icon: transportState.deafened ? HeadphoneOff : Headphones,
      badge: transportState.deafened ? "On" : "Off",
      action: { kind: "act", keepOpen: true, perform: () => toggleDeafen() },
    });

    cmds.push({
      id: "actions.call.camera",
      title: transportState.cameraOff ? "Turn on camera" : "Turn off camera",
      group: "Call",
      icon: transportState.cameraOff ? CameraOff : Camera,
      badge: transportState.cameraOff ? "Off" : "On",
      action: {
        kind: "act",
        keepOpen: true,
        perform: () => cameraOnPressed(),
      },
    });

    cmds.push({
      id: "actions.call.screenShare",
      title: transportState.screenSharing
        ? "Stop screen share"
        : "Start screen share",
      group: "Call",
      icon: transportState.screenSharing ? MonitorOff : Monitor,
      badge: transportState.screenSharing ? "Sharing" : "Off",
      action: {
        kind: "act",
        keepOpen: true,
        perform: transportState.screenSharing
          ? () => stopScreenShare()
          : () => openSharePicker(),
      },
    });

    const callRoom = transportState.callRoomCode;
    if (callRoom && transportState.uiRoomCode !== callRoom) {
      cmds.push({
        id: "actions.call.return",
        title: "Back to call",
        keywords: ["return", "go to call"],
        group: "Call",
        icon: CornerUpLeft,
        action: { kind: "act", perform: () => requestReturnToCall() },
      });
    }

    // Only with a picture to float - a voice-only call has none.
    if (browserPipSupported() && spotlightStore.spotlightTile?.videoTrack) {
      cmds.push({
        id: "actions.call.pip",
        title: callPipPanel.browserPip
          ? "Exit picture-in-picture"
          : "Picture-in-picture",
        keywords: ["pip", "float", "popout", "window"],
        group: "Call",
        icon: PictureInPicture2,
        action: {
          kind: "act",
          perform: () =>
            void (callPipPanel.browserPip
              ? exitBrowserPip()
              : enterBrowserPip(() => requestReturnToCall())),
        },
      });
    }

    // Every share on offer in this call, and every one being watched - each
    // its own row, so the one you mean is the one that starts or stops.
    const inThisCall = (pid: string) =>
      transportState.callPeerRooms.get(pid) === callRoom;
    for (const [pid, producerId] of transportState.pendingTransmissions) {
      if (!inThisCall(pid)) continue;
      cmds.push({
        id: `actions.watch:${pid}`,
        title: `Watch ${peerName(pid)}'s screen`,
        keywords: ["screen share", "stream", "watch"],
        group: "Call",
        icon: Monitor,
        action: {
          kind: "act",
          perform: () =>
            void watchTransmission(pid, producerId).catch((err) =>
              console.warn("watch failed", err)
            ),
        },
      });
    }
    for (const pid of transportState.watchingTransmissions.keys()) {
      cmds.push({
        id: `actions.stopWatching:${pid}`,
        title: `Stop watching ${peerName(pid)}`,
        keywords: ["screen share", "stream", "watch"],
        group: "Call",
        icon: MonitorOff,
        action: { kind: "act", perform: () => stopWatchingTransmission(pid) },
      });
    }
  }

  // In a call elsewhere, and this room has one going: move to it.
  const here = transportState.roomCode;
  if (
    transportState.inCall &&
    here &&
    transportState.callRoomCode !== here &&
    [...transportState.callPeerRooms.values()].includes(here)
  ) {
    cmds.push({
      id: "actions.call.switch",
      title: "Switch to this room's call",
      subtitle: "Leaves the call you are in",
      keywords: ["join", "move", "call"],
      group: "Call",
      icon: Phone,
      action: {
        kind: "act",
        perform: () => {
          leaveCall();
          joinCall().catch((err) => console.warn("switch call failed", err));
        },
      },
    });
  }

  cmds.push({
    id: "actions.help.shortcuts",
    title: "Keyboard shortcuts",
    subtitle: "Also under ? in this palette",
    keywords: ["keys", "hotkeys", "help", "keybindings"],
    group: "App",
    icon: Keyboard,
    action: {
      kind: "page",
      open: () => ({
        kind: "list",
        id: "help.shortcuts",
        title: "Keyboard shortcuts",
        items: shortcutRows,
      }),
    },
  });

  cmds.push({
    id: "actions.app.reconnect",
    title: "Reconnect",
    group: "App",
    icon: RefreshCw,
    action: {
      kind: "act",
      perform: () => {
        connect().catch((err) => console.warn("reconnect failed", err));
      },
    },
  });

  cmds.push({
    id: "actions.app.lock",
    title: "Lock the app",
    group: "App",
    icon: Lock,
    action: { kind: "act", perform: () => lock() },
  });

  cmds.push({
    id: "actions.app.persistentStorage",
    title: "Request persistent storage",
    group: "App",
    icon: HardDrive,
    action: {
      kind: "act",
      perform: () => {
        requestPersistentStorage().catch((err) =>
          console.warn("request persistent storage failed", err)
        );
      },
    },
  });

  cmds.push({
    id: "actions.app.downloadData",
    title: "Download my data",
    group: "App",
    icon: Download,
    action: {
      kind: "act",
      // The export asks for a passphrase now, and that prompt lives in the
      // Data settings; a bare download here would fall back to a native
      // prompt that shows the passphrase in the clear.
      perform: () => openSettings("data"),
    },
  });

  cmds.push({
    id: "actions.app.eraseData",
    title: "Erase all local data",
    group: "App",
    icon: Trash2,
    danger: true,
    action: {
      kind: "page",
      open: () => ({
        kind: "confirm",
        id: "actions.app.eraseData",
        title: "Erase all local data",
        message:
          "This deletes your identity, messages, and every room on this device. This cannot be undone.",
        confirmLabel: "Erase everything",
        confirm: async () => {
          try {
            await wipeLocalDatabase();
          } catch (err) {
            console.warn("wipe local database failed", err);
            return;
          }
          window.location.reload();
        },
      }),
    },
  });

  return cmds;
};
