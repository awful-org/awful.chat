import { cleanActivity } from "./plugins/activity-label";

/**
 * What a person says they are doing in a call: sharing their screen, in a
 * plugin's tile. It travels in the CallState frame, beside mute and deafen,
 * so everyone in the room has it, in whichever voice channel they are or in
 * none - and nobody has it from somebody who turned it off.
 */
export interface CallActivity {
  /** The plugin it is in, whose icon stands for it. */
  plugin: string;
  /** One plain line: "In Waffle Party", "Playing Jeopardy". */
  label: string;
}

export interface CallStatus {
  sharing: boolean;
  activities: CallActivity[];
}

/** The wire form: what is not so is left out. */
export interface WireCallStatus {
  sharing?: true;
  activities?: CallActivity[];
}

/** As many as a row has room for. */
export const MAX_ACTIVITIES = 3;
const PLUGIN_ID_RE = /^[a-z0-9-]{2,32}$/;

export const NO_CALL_STATUS: Readonly<CallStatus> = { sharing: false, activities: [] };

/**
 * What goes out. Always there, empty or not: an empty one says "nothing, or
 * not telling", and only an older build sends none at all.
 */
export function wireCallStatus(status: Readonly<CallStatus>): WireCallStatus {
  const activities = status.activities.slice(0, MAX_ACTIVITIES);
  return {
    ...(status.sharing ? { sharing: true as const } : {}),
    ...(activities.length ? { activities } : {}),
  };
}

/** A peer's status, checked field by field; null from a build that sends none. */
export function parseCallStatus(raw: unknown): CallStatus | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  const activities: CallActivity[] = [];
  const list = Array.isArray(r.activities) ? r.activities.slice(0, MAX_ACTIVITIES) : [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { plugin, label } = item as Record<string, unknown>;
    if (typeof plugin !== "string" || !PLUGIN_ID_RE.test(plugin)) continue;
    const clean = cleanActivity(label);
    if (clean && !activities.some((a) => a.plugin === plugin)) activities.push({ plugin, label: clean });
  }
  return { sharing: r.sharing === true, activities };
}
