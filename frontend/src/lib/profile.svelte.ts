import { identityStore } from "$lib/identity.svelte";
import {
  getOwnProfile,
  putOwnProfile,
  updateOwnProfile,
  pfpBlobURL,
} from "$lib/storage";
import { broadcastProfile } from "$lib/transport.svelte";

interface ProfileStore {
  nickname: string;
  avatarUrl: string | undefined;
}

export const profileStore = $state<ProfileStore>({
  nickname: "Anonymous",
  avatarUrl: undefined,
});

let _blobUrl: string | undefined;

export async function loadProfile(): Promise<void> {
  const p = await getOwnProfile();
  if (!p) return;
  profileStore.nickname = p.nickname || "Anonymous";
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

async function ensureProfile(): Promise<void> {
  const existing = await getOwnProfile();
  if (!existing) {
    await putOwnProfile({
      did: identityStore.did ?? "",
      isMe: true,
      nickname: profileStore.nickname || "Anonymous",
      updatedAt: Date.now(),
    });
  }
}

export async function saveAvatar(url: string | undefined): Promise<void> {
  profileStore.avatarUrl = url;
  await ensureProfile();
  await updateOwnProfile({ pfpURL: url, pfpData: undefined });
  broadcastProfile();
}

export async function saveName(name: string): Promise<void> {
  profileStore.nickname = name;
  await ensureProfile();
  await updateOwnProfile({ nickname: name });
  broadcastProfile();
}
