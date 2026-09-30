import type { OwnProfile } from "./storage";
import { validateProfileMeta } from "./profile-meta";
import { normalizeAvatarUrl, normalizeNicknameColor } from "./utils";
import { normalizeWireName } from "./wire-name";

/** The avatar and banner limits the picker enforces (AvatarPickerDialog). */
export const MAX_ROOM_AVATAR_BYTES = 512 * 1024;
export const MAX_ROOM_BANNER_BYTES = 1_000_000;

/** Only presentation fields may be overridden; identity and timestamps remain main-scoped. */
export type RoomProfileField = Exclude<keyof OwnProfile, "did" | "isMe" | "updatedAt">;
export type RoomProfileFields = Partial<{
  [K in RoomProfileField]: OwnProfile[K] | null;
}>;

export function hasRoomOverrides(fields: RoomProfileFields): boolean {
  return Object.keys(fields).length > 0;
}

/** null is a persisted explicit clear; absence means inherit from main. */
export function resolveRoomProfile(main: OwnProfile, fields: RoomProfileFields = {}): OwnProfile {
  const effective = { ...main };
  // Each image is one presentation field with two storage representations.
  // Choosing or clearing either representation overrides the inherited pair.
  if (Object.hasOwn(fields, "pfpURL")) delete effective.pfpData;
  if (Object.hasOwn(fields, "pfpData")) delete effective.pfpURL;
  if (Object.hasOwn(fields, "bannerURL")) delete effective.bannerData;
  if (Object.hasOwn(fields, "bannerData")) delete effective.bannerURL;
  for (const key of Object.keys(fields) as RoomProfileField[]) {
    const value = fields[key];
    if (value === null) delete (effective as Partial<OwnProfile>)[key];
    else if (value !== undefined) (effective as Record<string, unknown>)[key] = value;
  }
  return effective;
}

/**
 * Overrides that did not come from this device's own editor - a backup file,
 * a paired device - put through the same checks a profile from the wire
 * gets. Each field is checked alone: an invalid one is dropped (the room
 * inherits it), an explicit clear (null) is kept, and image bytes over the
 * picker's limits are dropped. A colour is the case that matters: it goes
 * straight into a style attribute.
 */
export function sanitizeRoomProfileFields(fields: RoomProfileFields): RoomProfileFields {
  const out: Record<string, unknown> = {};
  const has = (key: RoomProfileField) => Object.hasOwn(fields, key);
  const keep = (key: RoomProfileField, value: unknown) => {
    if (fields[key] === null) out[key] = null;
    else if (value !== undefined && value !== null && value !== "") out[key] = value;
  };
  if (has("nickname") && typeof fields.nickname === "string") keep("nickname", normalizeWireName(fields.nickname));
  else if (fields.nickname === null) out.nickname = null;
  if (has("pfpURL")) keep("pfpURL", normalizeAvatarUrl(fields.pfpURL ?? undefined));
  if (has("bannerURL")) keep("bannerURL", normalizeAvatarUrl(fields.bannerURL ?? undefined));
  if (has("color")) keep("color", normalizeNicknameColor(fields.color ?? undefined));
  const meta = validateProfileMeta({
    tagText: fields.tagText ?? undefined,
    tagTextColor: fields.tagTextColor ?? undefined,
    tagChipColor: fields.tagChipColor ?? undefined,
    bio: fields.bio ?? undefined,
    nameEffect: fields.nameEffect ?? undefined,
    nameShimmer: fields.nameShimmer ?? undefined,
    nameGlow: fields.nameGlow ?? undefined,
    gradient2: fields.gradient2 ?? undefined,
    gradient3: fields.gradient3 ?? undefined,
  });
  for (const key of ["tagText", "tagTextColor", "tagChipColor", "bio", "nameEffect",
    "nameShimmer", "nameGlow", "gradient2", "gradient3"] as const) {
    if (has(key)) keep(key, meta[key]);
  }
  const bytes = (key: "pfpData" | "bannerData", max: number) => {
    const value = fields[key];
    if (value === null) out[key] = null;
    else if (value instanceof ArrayBuffer && value.byteLength > 0 && value.byteLength <= max) out[key] = value;
  };
  bytes("pfpData", MAX_ROOM_AVATAR_BYTES);
  bytes("bannerData", MAX_ROOM_BANNER_BYTES);
  return out as RoomProfileFields;
}
