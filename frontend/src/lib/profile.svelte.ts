import { identityStore } from "$lib/identity/identity.svelte";
import {
  getOwnProfile,
  putOwnProfile,
  updateOwnProfile,
  rekeyOwnProfile,
  pfpBlobURL,
  getAllOwnRoomProfiles,
  getOwnRoomProfile,
  putOwnRoomProfile,
  type OwnProfile,
  type OwnRoomProfileRecord,
} from "$lib/storage";
import { roomsStore } from "$lib/rooms.svelte";
import { hasRoomOverrides, resolveRoomProfile, type RoomProfileFields } from "$lib/room-profile";
import { bytesToBase64, sniffImageMime } from "$lib/utils";

/**
 * Tell the peers about a change. Only an unlocked session has any: the
 * transport connects after the unlock, disconnects at a lock, and announces
 * the profile itself to each peer it connects to. The setup screen saves the
 * name and the avatar through here before the unlock, on a screen that shows
 * before the app - libp2p, the call stack - has even downloaded
 * (IdentityGate.svelte), so the transport is imported once there is someone
 * to tell, not with this module.
 */
function broadcastProfile(): void {
  if (!identityStore.isUnlocked) return;
  void import("$lib/transport/transport.svelte")
    .then((transport) => transport.broadcastProfile())
    .catch(() => {});
}

interface ProfileStore {
  nickname: string;
  avatarUrl: string | undefined;
  /** User-picked nickname color, hex like "#aabbcc". Absent = default. */
  color: string | undefined;
  bannerUrl: string | undefined;
  tagText: string | undefined;
  tagTextColor: string | undefined;
  tagChipColor: string | undefined;
  bio: string | undefined;
  nameEffect: string | undefined;
  nameShimmer: boolean | undefined;
  nameGlow: boolean | undefined;
  gradient2: string | undefined;
  gradient3: string | undefined;
}

export const profileStore = $state<ProfileStore>({
  nickname: "Anonymous",
  avatarUrl: undefined,
  color: undefined,
  bannerUrl: undefined,
  tagText: undefined,
  tagTextColor: undefined,
  tagChipColor: undefined,
  bio: undefined,
  nameEffect: undefined,
  nameShimmer: undefined,
  nameGlow: undefined,
  gradient2: undefined,
  gradient3: undefined,
});

let _blobUrl: string | undefined;
export const roomProfileStore = $state<{ records: Map<string, OwnRoomProfileRecord> }>({ records: new Map() });
function nextFieldEdit(previous?: { at: number }) {
  const at = Math.max(Date.now(), (previous?.at ?? 0) + 1);
  return { at, id: `${crypto.randomUUID()}` };
}

/**
 * A room image as a data URL, encoded once per buffer. getScopedProfile runs
 * several times per own message on every render, and base64-encoding a
 * half-megabyte avatar each time was the whole cost of it.
 */
const _dataUrls = new WeakMap<ArrayBuffer, string>();
function dataUrlOf(data: ArrayBuffer): string {
  let url = _dataUrls.get(data);
  if (!url) {
    const bytes = new Uint8Array(data);
    url = `data:${sniffImageMime(bytes)};base64,${bytesToBase64(bytes)}`;
    _dataUrls.set(data, url);
  }
  return url;
}

export function getScopedProfile(roomCode: string | null = null): ProfileStore {
  if (!roomCode || !roomsStore.rooms.some(r => r.roomCode === roomCode && r.type === "text")) return profileStore;
  const main: OwnProfile = {
    did: identityStore.did ?? "", isMe: true, updatedAt: 0,
    nickname: profileStore.nickname, pfpURL: profileStore.avatarUrl,
    bannerURL: profileStore.bannerUrl, color: profileStore.color,
    tagText: profileStore.tagText, tagTextColor: profileStore.tagTextColor,
    tagChipColor: profileStore.tagChipColor, bio: profileStore.bio,
    nameEffect: profileStore.nameEffect, nameShimmer: profileStore.nameShimmer,
    nameGlow: profileStore.nameGlow, gradient2: profileStore.gradient2,
    gradient3: profileStore.gradient3,
  };
  const record = roomProfileStore.records.get(roomCode);
  const p = resolveRoomProfile(main, record?.did === main.did ? record.fields : undefined);
  return {
    nickname: p.nickname, avatarUrl: p.pfpURL ?? (p.pfpData ? dataUrlOf(p.pfpData) : undefined),
    bannerUrl: p.bannerURL ?? (p.bannerData ? dataUrlOf(p.bannerData) : undefined),
    color: p.color, tagText: p.tagText, tagTextColor: p.tagTextColor,
    tagChipColor: p.tagChipColor, bio: p.bio, nameEffect: p.nameEffect,
    nameShimmer: p.nameShimmer, nameGlow: p.nameGlow,
    gradient2: p.gradient2, gradient3: p.gradient3,
  };
}

export function hasScopedOverrides(roomCode: string): boolean {
  return hasRoomOverrides(roomProfileStore.records.get(roomCode)?.fields ?? {});
}

export async function loadRoomProfile(roomCode: string): Promise<void> {
  const did = identityStore.did;
  if (!did) return;
  const record = await getOwnRoomProfile(roomCode, did);
  const next = new Map(roomProfileStore.records);
  if (record) next.set(roomCode, record);
  else next.delete(roomCode);
  roomProfileStore.records = next;
}

/** Capture the scope at call time; serialize writes so concurrent field edits merge. */
export async function saveScopedFields(roomCode: string, patch: RoomProfileFields): Promise<void> {
  const did = identityStore.did;
  const room = roomsStore.rooms.find(r => r.roomCode === roomCode && r.type === "text");
  if (!did || !room) throw new Error("room is not joined");
  await chained(async () => {
    const existing = await getOwnRoomProfile(roomCode, did);
    const fields = { ...(existing?.fields ?? {}), ...patch };
    const fieldEdits = { ...existing?.fieldEdits };
    for (const [key, other] of [["pfpURL", "pfpData"], ["pfpData", "pfpURL"], ["bannerURL", "bannerData"], ["bannerData", "bannerURL"]] as const) {
      if (!Object.hasOwn(patch, key)) continue;
      delete fields[other];
      fieldEdits[other] = { ...nextFieldEdit(fieldEdits[other]), reset: true };
    }
    for (const field of Object.keys(patch) as (keyof RoomProfileFields)[]) {
      fieldEdits[field] = nextFieldEdit(fieldEdits[field]);
    }
    const record: OwnRoomProfileRecord = { roomCode, did, generation: room.createdAt, fields, fieldEdits };
    await putOwnRoomProfile(record);
    roomProfileStore.records = new Map(roomProfileStore.records).set(roomCode, record);
  });
  broadcastProfile();
}

export async function resetScopedProfile(roomCode: string): Promise<void> {
  const did = identityStore.did;
  const room = roomsStore.rooms.find(r => r.roomCode === roomCode && r.type === "text");
  if (!did || !room) throw new Error("room is not joined");
  await chained(async () => {
    const existing = await getOwnRoomProfile(roomCode, did);
    const fieldEdits = { ...existing?.fieldEdits };
    for (const field of Object.keys(existing?.fields ?? {}) as (keyof RoomProfileFields)[]) {
      fieldEdits[field] = { ...nextFieldEdit(fieldEdits[field]), reset: true };
    }
    const record: OwnRoomProfileRecord = { roomCode, did, generation: room.createdAt, fields: {}, fieldEdits };
    await putOwnRoomProfile(record);
    roomProfileStore.records = new Map(roomProfileStore.records).set(roomCode, record);
  });
  broadcastProfile();
}

export async function loadProfile(): Promise<void> {
  const ownRooms = await getAllOwnRoomProfiles();
  roomProfileStore.records = new Map(ownRooms.filter(r => r.did === identityStore.did).map(r => [r.roomCode, r]));
  const p = await getOwnProfile(identityStore.did ?? undefined);
  if (!p) return;
  // Repair profiles written before the identity was known: the row was keyed
  // by an empty did, which detaches it from the identity it belongs to.
  if (!p.did && identityStore.did) {
    await rekeyOwnProfile(p.did ?? "", identityStore.did);
  }
  profileStore.nickname = p.nickname || "Anonymous";
  profileStore.color = p.color;
  if (p.bannerURL) {
    profileStore.bannerUrl = p.bannerURL;
  } else if (p.bannerData) {
    // A data URL also survives saving the picker without editing the image;
    // a temporary blob URL would become an unusable banner on other devices.
    const bytes = new Uint8Array(p.bannerData);
    profileStore.bannerUrl = `data:${sniffImageMime(bytes)};base64,${bytesToBase64(bytes)}`;
  } else {
    profileStore.bannerUrl = undefined;
  }
  profileStore.tagText = p.tagText;
  profileStore.tagTextColor = p.tagTextColor;
  profileStore.tagChipColor = p.tagChipColor;
  profileStore.bio = p.bio;
  profileStore.nameEffect = p.nameEffect;
  profileStore.nameShimmer = p.nameShimmer;
  profileStore.nameGlow = p.nameGlow;
  profileStore.gradient2 = p.gradient2;
  profileStore.gradient3 = p.gradient3;
  if (_blobUrl) {
    URL.revokeObjectURL(_blobUrl);
    _blobUrl = undefined;
  }
  if (p.pfpURL) {
    profileStore.avatarUrl = p.pfpURL;
  } else if (p.pfpData) {
    _blobUrl = pfpBlobURL(p.pfpData);
    profileStore.avatarUrl = _blobUrl;
  } else {
    profileStore.avatarUrl = undefined;
  }
}

// saveName and saveAvatar can run near-simultaneously during first-run setup;
// each is a check-then-create followed by a patch, and interleaving them let
// the later create erase the earlier patch (the signup avatar vanished).
// Serializing the pairs is enough - no storage changes needed.
let _profileChain: Promise<void> = Promise.resolve();
function chained(fn: () => Promise<void>): Promise<void> {
  const next = _profileChain.then(fn, fn);
  _profileChain = next.catch(() => {});
  return next;
}

async function ensureProfile(did?: string): Promise<void> {
  const existing = await getOwnProfile(identityStore.did ?? undefined);
  if (!existing) {
    await putOwnProfile({
      did: did ?? identityStore.did ?? "",
      isMe: true,
      nickname: profileStore.nickname || "Anonymous",
      updatedAt: Date.now(),
    });
  }
}

export async function saveAvatar(url: string | undefined): Promise<void> {
  profileStore.avatarUrl = url;
  await chained(async () => {
    await ensureProfile();
    await updateOwnProfile({ pfpURL: url, pfpData: undefined });
  });
  broadcastProfile();
}

/**
 * @param did - pass explicitly during signup: the profile row is keyed by did,
 * and identityStore.did is not populated until the session is finalised.
 */
export async function saveName(name: string, did?: string): Promise<void> {
  profileStore.nickname = name;
  await chained(async () => {
    await ensureProfile(did);
    await updateOwnProfile({ nickname: name });
  });
  broadcastProfile();
}

/**
 * @param color - the picked hex color, or undefined/null to reset to default.
 * Values are sanitized on receipt from the wire; here we trust the picker.
 */
export async function saveColor(color: string | undefined | null): Promise<void> {
  profileStore.color = color ?? undefined;
  await chained(async () => {
    await ensureProfile();
    await updateOwnProfile({ color: color ?? undefined });
  });
  broadcastProfile();
}

export async function saveBanner(url: string | undefined): Promise<void> {
  profileStore.bannerUrl = url;
  await chained(async () => {
    await ensureProfile();
    await updateOwnProfile({ bannerURL: url, bannerData: undefined });
  });
  broadcastProfile();
}

export async function saveTag(tagText: string | undefined): Promise<void> {
  tagText = tagText?.toUpperCase();
  profileStore.tagText = tagText;
  await chained(async () => {
    await ensureProfile();
    await updateOwnProfile({ tagText: tagText ?? undefined });
  });
  broadcastProfile();
}

export async function saveTagColors(
  textColor: string | undefined,
  chipColor: string | undefined
): Promise<void> {
  profileStore.tagTextColor = textColor;
  profileStore.tagChipColor = chipColor;
  await chained(async () => {
    await ensureProfile();
    await updateOwnProfile({
      tagTextColor: textColor ?? undefined,
      tagChipColor: chipColor ?? undefined,
    });
  });
  broadcastProfile();
}

export async function saveBio(bio: string | undefined): Promise<void> {
  profileStore.bio = bio;
  await chained(async () => {
    await ensureProfile();
    await updateOwnProfile({ bio: bio ?? undefined });
  });
  broadcastProfile();
}

export async function saveNameEffectFields(
  nameEffect: string | undefined,
  nameShimmer: boolean | undefined,
  nameGlow: boolean | undefined
): Promise<void> {
  profileStore.nameEffect = nameEffect;
  profileStore.nameShimmer = nameShimmer;
  profileStore.nameGlow = nameGlow;
  await chained(async () => {
    await ensureProfile();
    await updateOwnProfile({
      nameEffect: nameEffect ?? undefined,
      nameShimmer: nameShimmer ?? undefined,
      nameGlow: nameGlow ?? undefined,
    });
  });
  broadcastProfile();
}

export async function saveGradientColors(
  gradient2: string | undefined,
  gradient3: string | undefined
): Promise<void> {
  profileStore.gradient2 = gradient2;
  profileStore.gradient3 = gradient3;
  await chained(async () => {
    await ensureProfile();
    await updateOwnProfile({
      gradient2: gradient2 ?? undefined,
      gradient3: gradient3 ?? undefined,
    });
  });
  broadcastProfile();
}
