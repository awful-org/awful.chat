/**
 * A peer profile that did NOT just arrive on the wire - read from storage, or
 * brought in by a backup - put through the same checks a live one gets.
 *
 * The live path validates every field (transport.svelte's _handleProfile).
 * Rows loaded back from IndexedDB, and rows a backup file carries, skipped
 * that: a colour like `red;background:url(https://x/beacon);position:fixed`
 * went straight into a style attribute - a tracking beacon and a full-screen
 * overlay out of a file someone handed you.
 */

import type { PeerProfile } from "$lib/storage";
import { validateProfileMeta } from "$lib/profile-meta";
import { normalizeAvatarUrl, normalizeNicknameColor } from "$lib/utils";
import { normalizeWireName } from "$lib/wire-name";

export function sanitizePeerProfile(p: PeerProfile): PeerProfile {
  const meta = validateProfileMeta({
    bannerUrl: p.bannerURL,
    gradient2: p.gradient2,
    gradient3: p.gradient3,
    tagText: p.tagText,
    tagTextColor: p.tagTextColor,
    tagChipColor: p.tagChipColor,
    bio: p.bio,
    nameEffect: p.nameEffect,
    nameShimmer: p.nameShimmer,
    nameGlow: p.nameGlow,
  });
  const {
    pfpURL: _pfpURL, color: _color, bannerURL: _bannerURL, gradient2: _g2, gradient3: _g3,
    tagText: _tagText, tagTextColor: _tagTextColor, tagChipColor: _tagChipColor, bio: _bio,
    nameEffect: _nameEffect, nameShimmer: _nameShimmer, nameGlow: _nameGlow, ...rest
  } = p;
  const pfpURL = normalizeAvatarUrl(p.pfpURL);
  const color = normalizeNicknameColor(p.color);
  return {
    ...rest,
    nickname: normalizeWireName(p.nickname),
    ...(pfpURL ? { pfpURL } : {}),
    ...(color ? { color } : {}),
    ...(meta.bannerUrl ? { bannerURL: meta.bannerUrl } : {}),
    ...(meta.gradient2 ? { gradient2: meta.gradient2 } : {}),
    ...(meta.gradient3 ? { gradient3: meta.gradient3 } : {}),
    ...(meta.tagText ? { tagText: meta.tagText } : {}),
    ...(meta.tagTextColor ? { tagTextColor: meta.tagTextColor } : {}),
    ...(meta.tagChipColor ? { tagChipColor: meta.tagChipColor } : {}),
    ...(meta.bio ? { bio: meta.bio } : {}),
    ...(meta.nameEffect ? { nameEffect: meta.nameEffect } : {}),
    ...(meta.nameShimmer !== undefined ? { nameShimmer: meta.nameShimmer } : {}),
    ...(meta.nameGlow !== undefined ? { nameGlow: meta.nameGlow } : {}),
  };
}
