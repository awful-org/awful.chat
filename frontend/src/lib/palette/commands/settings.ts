import {
  Activity,
  ChartPie,
  Heart,
  Info,
  Mic,
  Puzzle,
  RefreshCw,
  SlidersHorizontal,
  User,
  Volume2,
} from "@lucide/svelte";
import {
  displayPrefs,
  setCallChatBeside,
  setAvatarTint,
  setCallPip,
  setItalicOwnName,
  setShowPeerNicknameColors,
  setSidebarCollapsed,
} from "$lib/display-prefs.svelte";
import {
  mediaPrefs,
  setGifAutoplay,
  setAutoDownloadMedia,
} from "$lib/media-prefs.svelte";
import {
  notifyState,
  setMessageSoundsEnabled,
  setNotificationsEnabled,
} from "$lib/notify.svelte";
import { mailboxPrefs, setMailboxEnabled } from "$lib/transport/mailbox.svelte";
import {
  getVoiceActiveInputDevice,
  getVoiceActiveOutputDevice,
  getVoiceDtlnEnabled,
  getVoiceInputDevices,
  getVoiceOutputDevices,
  setVoiceDtlnEnabled,
  setVoiceInputDevice,
  setVoiceOutputDevice,
} from "$lib/transport/voice.svelte";
import {
  profileStore,
  saveName,
  saveNameEffectFields,
} from "$lib/profile.svelte";
import {
  modelToWire,
  wireToModel,
  type NameEffectModel,
} from "$lib/name-effect";
import { openSettings } from "$lib/ui-state.svelte";
import { getRegistry } from "$lib/plugins/registry";
import { isPluginEnabled, togglePlugin } from "$lib/plugins/prefs.svelte";
import type { Cmd } from "../types";
import type { CmdSource } from "../host";

/** Settings-dialog tabs, copied verbatim from SettingsDialog.svelte so the
 *  palette's shortcuts stay visually identical to the dialog's own tab bar. */
const SETTINGS_TABS = [
  { id: "profile", label: "Profile", icon: User },
  { id: "audio", label: "Audio", icon: Volume2 },
  { id: "app", label: "App", icon: SlidersHorizontal },
  { id: "session", label: "Session/Sync", icon: RefreshCw },
  { id: "data", label: "Data", icon: ChartPie },
  { id: "diagnostics", label: "Diagnostics", icon: Activity },
  { id: "plugins", label: "Plugins", icon: Puzzle },
  { id: "quirks", label: "Quirks", icon: Info },
  { id: "oss", label: "OSS", icon: Heart },
] as const;

// Fills are exclusive - they all claim background-clip: text - so only these
// three belong in a pick-one list. Shimmer and glow are modifiers and get
// their own toggle rows below, the same split the settings editor uses.
const NAME_FILLS = [
  { value: "none", label: "None" },
  { value: "gradient", label: "Gradient" },
  { value: "rainbow", label: "Rainbow" },
] as const;

/**
 * Preference toggles, plugin toggles, settings-tab shortcuts, and the
 * device/name-effect/nickname pickers.
 *
 * Every toggle re-reads its `$state` object here, at build time, so the
 * badge always reflects the value on screen right now.
 */
export const settingsCommands: CmdSource = () => {
  const cmds: Cmd[] = [];

  cmds.push({
    id: "settings.toggle:italicOwnName",
    title: "Italic own name",
    keywords: ["toggle", "enable", "disable", "italicize", "font style"],
    group: "Settings",
    badge: displayPrefs.italicOwnName ? "On" : "Off",
    action: {
      kind: "act",
      keepOpen: true,
      perform: () => setItalicOwnName(!displayPrefs.italicOwnName),
    },
  });

  cmds.push({
    id: "settings.toggle:peerNicknameColors",
    title: "Peer nickname colors",
    keywords: ["toggle", "enable", "disable", "colours"],
    group: "Settings",
    badge: displayPrefs.showPeerNicknameColors ? "On" : "Off",
    action: {
      kind: "act",
      keepOpen: true,
      perform: () =>
        setShowPeerNicknameColors(!displayPrefs.showPeerNicknameColors),
    },
  });

  cmds.push({
    id: "settings.toggle:sidebarCollapsed",
    title: "Collapsed sidebar",
    keywords: ["toggle", "enable", "disable", "icon rail"],
    group: "Settings",
    shortcut: ["⌘", "B"],
    badge: displayPrefs.sidebarCollapsed ? "On" : "Off",
    action: {
      kind: "act",
      keepOpen: true,
      perform: () => setSidebarCollapsed(!displayPrefs.sidebarCollapsed),
    },
  });

  cmds.push({
    id: "settings.toggle:callChatBeside",
    title: "Chat beside call",
    keywords: ["toggle", "enable", "disable", "layout"],
    group: "Settings",
    badge: displayPrefs.callChatBeside ? "On" : "Off",
    action: {
      kind: "act",
      keepOpen: true,
      perform: () => setCallChatBeside(!displayPrefs.callChatBeside),
    },
  });

  cmds.push({
    id: "settings.toggle:callPip",
    title: "Call picture-in-picture",
    keywords: ["toggle", "enable", "disable", "pip", "floating", "call"],
    group: "Settings",
    badge: displayPrefs.callPip ? "On" : "Off",
    action: {
      kind: "act",
      keepOpen: true,
      perform: () => setCallPip(!displayPrefs.callPip),
    },
  });

  cmds.push({
    id: "settings.toggle:avatarTint",
    title: "Tint call tiles from avatars",
    keywords: ["toggle", "enable", "disable", "color", "colour", "grain", "call"],
    group: "Settings",
    badge: displayPrefs.avatarTint ? "On" : "Off",
    action: {
      kind: "act",
      keepOpen: true,
      perform: () => setAvatarTint(!displayPrefs.avatarTint),
    },
  });

  cmds.push({
    id: "settings.toggle:gifAutoplay",
    title: "GIF autoplay",
    keywords: ["toggle", "enable", "disable"],
    group: "Settings",
    badge: mediaPrefs.gifAutoplay ? "On" : "Off",
    action: {
      kind: "act",
      keepOpen: true,
      perform: () => setGifAutoplay(!mediaPrefs.gifAutoplay),
    },
  });

  cmds.push({
    id: "settings.toggle:autoDownloadMedia",
    title: "Auto-download media",
    keywords: ["toggle", "enable", "disable", "files", "images"],
    group: "Settings",
    badge: mediaPrefs.autoDownloadMedia ? "On" : "Off",
    action: {
      kind: "act",
      keepOpen: true,
      perform: () => setAutoDownloadMedia(!mediaPrefs.autoDownloadMedia),
    },
  });

  cmds.push({
    id: "settings.toggle:messageSounds",
    title: "Message sounds",
    keywords: ["toggle", "enable", "disable", "mute"],
    group: "Settings",
    badge: notifyState.soundsEnabled ? "On" : "Off",
    action: {
      kind: "act",
      keepOpen: true,
      perform: () => setMessageSoundsEnabled(!notifyState.soundsEnabled),
    },
  });

  if (notifyState.supported) {
    cmds.push({
      id: "settings.toggle:notifications",
      title: "Notifications",
      keywords: ["toggle", "enable", "disable"],
      group: "Settings",
      badge: notifyState.enabled ? "On" : "Off",
      action: {
        kind: "act",
        keepOpen: true,
        perform: () => {
          setNotificationsEnabled(!notifyState.enabled).catch((err) =>
            console.warn("toggle notifications failed", err)
          );
        },
      },
    });
  }

  cmds.push({
    id: "settings.toggle:offlineInbox",
    title: "Offline inbox",
    keywords: ["toggle", "enable", "disable", "mailbox"],
    group: "Settings",
    badge: mailboxPrefs.enabled ? "On" : "Off",
    action: {
      kind: "act",
      keepOpen: true,
      perform: () => setMailboxEnabled(!mailboxPrefs.enabled),
    },
  });

  cmds.push({
    id: "settings.toggle:noiseSuppression",
    title: "Noise suppression",
    keywords: ["toggle", "enable", "disable", "dtln"],
    group: "Settings",
    badge: getVoiceDtlnEnabled() ? "On" : "Off",
    action: {
      kind: "act",
      keepOpen: true,
      perform: () => {
        setVoiceDtlnEnabled(!getVoiceDtlnEnabled()).catch((err) =>
          console.warn("toggle noise suppression failed", err)
        );
      },
    },
  });

  for (const [pluginId, entry] of getRegistry()) {
    const enabled = isPluginEnabled(pluginId);
    cmds.push({
      id: `settings.plugin:${pluginId}`,
      title: entry.manifest.name,
      subtitle: entry.manifest.description,
      group: "Plugins",
      icon: Puzzle,
      badge: enabled ? "On" : "Off",
      action: {
        kind: "act",
        keepOpen: true,
        perform: () => togglePlugin(pluginId, !enabled),
      },
    });
  }

  for (const tab of SETTINGS_TABS) {
    cmds.push({
      id: `settings.open:${tab.id}`,
      // The tab label alone is not searchable or self-describing: a row reading
      // just "App" means nothing out of context, and typing "settings" found
      // none of these at all.
      title: `Open ${tab.label} settings`,
      keywords: ["preferences", "options", "configure"],
      group: "Settings",
      icon: tab.icon,
      action: { kind: "act", perform: () => openSettings(tab.id) },
    });
  }

  cmds.push({
    id: "settings.audioInput",
    title: "Audio input device",
    group: "Settings",
    icon: Mic,
    action: {
      kind: "page",
      open: () => ({
        kind: "list",
        id: "settings.audioInput",
        title: "Audio input device",
        placeholder: "Search devices…",
        emptyText: "No input devices found",
        items: async () => {
          const devices = await getVoiceInputDevices();
          const active = getVoiceActiveInputDevice();
          return devices.map((device, index): Cmd => ({
            id: `settings.audioInput:${device.deviceId}`,
            title: device.label || `Microphone ${index + 1}`,
            group: "Devices",
            badge: device.deviceId === active ? "Active" : undefined,
            action: {
              kind: "act",
              perform: () => {
                setVoiceInputDevice(device.deviceId).catch((err) =>
                  console.warn("set audio input device failed", err)
                );
              },
            },
          }));
        },
      }),
    },
  });

  cmds.push({
    id: "settings.audioOutput",
    title: "Audio output device",
    group: "Settings",
    icon: Volume2,
    action: {
      kind: "page",
      open: () => ({
        kind: "list",
        id: "settings.audioOutput",
        title: "Audio output device",
        placeholder: "Search devices…",
        emptyText: "No output devices found",
        items: async () => {
          const devices = await getVoiceOutputDevices();
          const active = getVoiceActiveOutputDevice();
          return devices.map((device, index): Cmd => ({
            id: `settings.audioOutput:${device.deviceId}`,
            title: device.label || `Speaker ${index + 1}`,
            group: "Devices",
            badge: device.deviceId === active ? "Active" : undefined,
            action: {
              kind: "act",
              perform: () => {
                setVoiceOutputDevice(device.deviceId).catch((err) =>
                  console.warn("set audio output device failed", err)
                );
              },
            },
          }));
        },
      }),
    },
  });

  cmds.push({
    id: "settings.nameEffect",
    title: "Name effect",
    group: "Settings",
    action: {
      kind: "page",
      open: () => ({
        kind: "list",
        id: "settings.nameEffect",
        title: "Name effect",
        items: () => {
          // Read the whole model, write the whole model. Writing just one of
          // the three stored fields is what leaves the other two stale and
          // lets this list disagree with the settings editor.
          const model = wireToModel(
            profileStore.nameEffect,
            profileStore.nameShimmer,
            profileStore.nameGlow
          );
          const save = (next: NameEffectModel) => {
            const wire = modelToWire(next);
            saveNameEffectFields(
              wire.nameEffect,
              wire.nameShimmer,
              wire.nameGlow
            ).catch((err) => console.warn("set name effect failed", err));
          };
          return [
            ...NAME_FILLS.map(
              (fill): Cmd => ({
                id: `settings.nameEffect:${fill.value}`,
                title: fill.label,
                group: "Fill",
                badge: model.fill === fill.value ? "Active" : undefined,
                action: {
                  kind: "act",
                  keepOpen: true,
                  perform: () => save({ ...model, fill: fill.value }),
                },
              })
            ),
            {
              id: "settings.nameEffect:shimmer",
              title: "Shimmer",
              group: "Add",
              badge: model.shimmer ? "On" : "Off",
              action: {
                kind: "act",
                keepOpen: true,
                perform: () => save({ ...model, shimmer: !model.shimmer }),
              },
            },
            {
              id: "settings.nameEffect:glow",
              title: "Glow",
              group: "Add",
              badge: model.glow ? "On" : "Off",
              action: {
                kind: "act",
                keepOpen: true,
                perform: () => save({ ...model, glow: !model.glow }),
              },
            },
          ];
        },
      }),
    },
  });

  cmds.push({
    id: "settings.nickname",
    title: "Nickname",
    group: "Settings",
    action: {
      kind: "page",
      open: () => ({
        kind: "prompt",
        id: "settings.nickname",
        title: "Change nickname",
        initial: profileStore.nickname,
        validate: (value) =>
          value.trim().length === 0 ? "Nickname cannot be empty" : null,
        submit: (value) => {
          saveName(value.trim()).catch((err) =>
            console.warn("save nickname failed", err)
          );
        },
        submitLabel: "Save",
      }),
    },
  });

  return cmds;
};
