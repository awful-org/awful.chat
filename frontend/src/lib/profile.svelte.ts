import { identityStore } from "$lib/identity/identity.svelte";
import {
  getOwnProfile,
  putOwnProfile,
  updateOwnProfile,
  rekeyOwnProfile,
  pfpBlobURL,
} from "$lib/storage";
import { broadcastProfile } from "$lib/transport/transport.svelte";

interface ProfileStore {
  nickname: string;
  avatarUrl: string | undefined;
  /** User-picked nickname color, hex like "#aabbcc". Absent = default. */
  color: string | undefined;
}

export const profileStore = $state<ProfileStore>({
  nickname: "Anonymous",
  avatarUrl: undefined,
  color: undefined,
});

let _blobUrl: string | undefined;

export async function loadProfile(): Promise<void> {
  const p = await getOwnProfile();
  if (!p) return;
  // Repair profiles written before the identity was known: the row was keyed
  // by an empty did, which detaches it from the identity it belongs to.
  if (!p.did && identityStore.did) {
    await rekeyOwnProfile(p.did ?? "", identityStore.did);
  }
  profileStore.nickname = p.nickname || "Anonymous";
  profileStore.color = p.color;
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
  const existing = await getOwnProfile();
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
