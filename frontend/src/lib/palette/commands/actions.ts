import {
  Camera,
  CameraOff,
  Download,
  HardDrive,
  Headphones,
  HeadphoneOff,
  Lock,
  Mic,
  MicOff,
  Monitor,
  MonitorOff,
  Phone,
  PhoneOff,
  RefreshCw,
  Trash2,
} from "@lucide/svelte";
import { transportState, connect } from "$lib/transport/transport.svelte";
import {
  joinCall,
  leaveCall,
  startScreenShare,
  stopScreenShare,
  toggleCamera,
  toggleDeafen,
  toggleMute,
} from "$lib/transport/call.svelte";
import { lock } from "$lib/identity/identity.svelte";
import { requestPersistentStorage, wipeLocalDatabase } from "$lib/storage";
import { downloadBackup } from "$lib/transport/sync.svelte";
import type { Cmd } from "../types";
import type { CmdSource } from "../host";

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
        perform: () => {
          toggleCamera().catch((err) =>
            console.warn("toggle camera failed", err)
          );
        },
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
          : () => {
              startScreenShare().catch((err) =>
                console.warn("start screen share failed", err)
              );
            },
      },
    });
  }

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
      perform: () => {
        downloadBackup().catch((err) =>
          console.warn("download backup failed", err)
        );
      },
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
