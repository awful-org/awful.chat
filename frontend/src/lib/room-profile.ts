import type { OwnProfile } from "./storage";

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
