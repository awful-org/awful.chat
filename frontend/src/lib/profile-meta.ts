/**
 * Profile metadata validation and sanitization.
 * Used at the trust boundary (receiving wire profiles) and by ProfileSettings.
 */

export interface ValidatedProfileMeta {
  tagText?: string;
  tagTextColor?: string;
  tagChipColor?: string;
  gradient2?: string;
  gradient3?: string;
  bio?: string;
  nameEffect?: string;
  bannerUrl?: string;
}

/**
 * Base64 raster image only, the same allowlist normalizeAvatarUrl applies to
 * avatars. A bare `data:image/` prefix test also let `data:image/svg+xml`
 * through, and SVG can carry script and external references - harmless while
 * both banner call sites are <img>, which neuters it, but the policy must not
 * depend on every future call site remembering that.
 */
const DATA_BANNER_RE =
  /^data:image\/(png|jpeg|jpg|gif|webp|avif);base64,[A-Za-z0-9+/]+=*$/;

/**
 * Validate and sanitize profile metadata from wire or settings.
 * Strict validation at trust boundary: missing or invalid fields are dropped,
 * not substituted with defaults.
 */
export function validateProfileMeta(meta: Partial<ValidatedProfileMeta>): ValidatedProfileMeta {
  const result: ValidatedProfileMeta = {};

  // Tag: 2-5 chars, trimmed
  if (typeof meta.tagText === "string") {
    // Tags are always uppercase - normalized here so it holds no matter
    // what a sender's client stored.
    const trimmed = meta.tagText.trim().slice(0, 5).toUpperCase();
    if (trimmed.length >= 2) {
      result.tagText = trimmed;
    }
  }

  // Bio: max 200 chars, plain text (no HTML)
  if (typeof meta.bio === "string") {
    const trimmed = meta.bio.slice(0, 200);
    if (trimmed.length > 0) {
      result.bio = trimmed;
    }
  }

  // Colors: hex format #RRGGBB
  const hexColorRegex = /^#[0-9a-fA-F]{6}$/;

  if (typeof meta.tagTextColor === "string" && hexColorRegex.test(meta.tagTextColor)) {
    result.tagTextColor = meta.tagTextColor;
  }

  if (typeof meta.tagChipColor === "string" && hexColorRegex.test(meta.tagChipColor)) {
    result.tagChipColor = meta.tagChipColor;
  }

  if (typeof meta.gradient2 === "string" && hexColorRegex.test(meta.gradient2)) {
    result.gradient2 = meta.gradient2;
  }
  if (typeof meta.gradient3 === "string" && hexColorRegex.test(meta.gradient3)) {
    result.gradient3 = meta.gradient3;
  }

  // Name effect: must be one of the enum values
  const validEffects = ["none", "gradient", "shimmer", "glow", "rainbow"];
  if (
    typeof meta.nameEffect === "string" &&
    validEffects.includes(meta.nameEffect)
  ) {
    result.nameEffect = meta.nameEffect;
  }

  // Banner URL: base64 raster data: image only, max 1.5 MB string length.
  // The length test runs first so a 1.5 MB string is never handed to the regex.
  if (typeof meta.bannerUrl === "string") {
    if (
      meta.bannerUrl.length <= 1_500_000 &&
      DATA_BANNER_RE.test(meta.bannerUrl)
    ) {
      result.bannerUrl = meta.bannerUrl;
    }
  }

  return result;
}
