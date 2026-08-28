import { describe, it, expect } from "vitest";
import { validateProfileMeta } from "./profile-meta";

describe("validateProfileMeta", () => {
  describe("tagText", () => {
    it("accepts 2-5 char tag text", () => {
      expect(validateProfileMeta({ tagText: "MOD" }).tagText).toBe("MOD");
      expect(validateProfileMeta({ tagText: "AB" }).tagText).toBe("AB");
      expect(validateProfileMeta({ tagText: "ADMIN" }).tagText).toBe("ADMIN");
    });

    it("trims whitespace", () => {
      expect(validateProfileMeta({ tagText: "  MOD  " }).tagText).toBe("MOD");
    });

    it("drops tags under 2 chars", () => {
      expect(validateProfileMeta({ tagText: "A" }).tagText).toBeUndefined();
      expect(validateProfileMeta({ tagText: "" }).tagText).toBeUndefined();
    });

    it("truncates tags over 5 chars", () => {
      expect(validateProfileMeta({ tagText: "MODERATION" }).tagText).toBe(
        "MODER"
      );
    });

    it("ignores non-string tagText", () => {
      expect(validateProfileMeta({ tagText: 123 as any }).tagText).toBeUndefined();
      expect(validateProfileMeta({ tagText: null as any }).tagText).toBeUndefined();
    });
  });

  describe("bio", () => {
    it("accepts bio text", () => {
      expect(validateProfileMeta({ bio: "Hello world" }).bio).toBe(
        "Hello world"
      );
    });

    it("truncates to 200 chars", () => {
      const longBio = "a".repeat(250);
      const result = validateProfileMeta({ bio: longBio }).bio;
      expect(result).toBe("a".repeat(200));
      expect(result?.length).toBe(200);
    });

    it("preserves line breaks", () => {
      const bioWithLineBreaks = "Line 1\nLine 2\nLine 3";
      expect(validateProfileMeta({ bio: bioWithLineBreaks }).bio).toBe(
        bioWithLineBreaks
      );
    });

    it("drops empty bio", () => {
      expect(validateProfileMeta({ bio: "" }).bio).toBeUndefined();
    });

    it("ignores non-string bio", () => {
      expect(validateProfileMeta({ bio: 123 as any }).bio).toBeUndefined();
    });
  });

  describe("colors", () => {
    it("accepts valid hex colors", () => {
      expect(validateProfileMeta({ tagTextColor: "#aabbcc" }).tagTextColor).toBe(
        "#aabbcc"
      );
      expect(validateProfileMeta({ tagChipColor: "#000000" }).tagChipColor).toBe(
        "#000000"
      );
      expect(validateProfileMeta({ tagChipColor: "#FFFFFF" }).tagChipColor).toBe(
        "#FFFFFF"
      );
    });

    it("drops invalid color formats", () => {
      expect(validateProfileMeta({ tagTextColor: "red" }).tagTextColor).toBeUndefined();
      expect(validateProfileMeta({ tagTextColor: "#aabbcc99" }).tagTextColor).toBeUndefined();
      expect(validateProfileMeta({ tagTextColor: "aabbcc" }).tagTextColor).toBeUndefined();
      expect(validateProfileMeta({ tagTextColor: "#gggggg" }).tagTextColor).toBeUndefined();
    });

    it("ignores non-string colors", () => {
      expect(validateProfileMeta({ tagTextColor: 123 as any }).tagTextColor).toBeUndefined();
    });
  });

  describe("nameEffect", () => {
    it("accepts valid effects", () => {
      expect(validateProfileMeta({ nameEffect: "none" }).nameEffect).toBe("none");
      expect(validateProfileMeta({ nameEffect: "gradient" }).nameEffect).toBe("gradient");
      expect(validateProfileMeta({ nameEffect: "shimmer" }).nameEffect).toBe("shimmer");
      expect(validateProfileMeta({ nameEffect: "glow" }).nameEffect).toBe("glow");
      expect(validateProfileMeta({ nameEffect: "rainbow" }).nameEffect).toBe("rainbow");
    });

    it("drops invalid effects", () => {
      expect(validateProfileMeta({ nameEffect: "invalid" }).nameEffect).toBeUndefined();
      expect(validateProfileMeta({ nameEffect: "blink" }).nameEffect).toBeUndefined();
    });

    it("ignores non-string effects", () => {
      expect(validateProfileMeta({ nameEffect: 123 as any }).nameEffect).toBeUndefined();
    });
  });

  describe("bannerUrl", () => {
    it("accepts valid data:image URLs", () => {
      const url = "data:image/png;base64,iVBORw0KGgo=";
      expect(validateProfileMeta({ bannerUrl: url }).bannerUrl).toBe(url);
    });

    it("accepts data:image/gif URLs", () => {
      const url = "data:image/gif;base64,R0lGODlhAQAB";
      expect(validateProfileMeta({ bannerUrl: url }).bannerUrl).toBe(url);
    });

    it("drops non-data:image URLs", () => {
      expect(validateProfileMeta({ bannerUrl: "http://example.com/banner.jpg" }).bannerUrl).toBeUndefined();
      expect(validateProfileMeta({ bannerUrl: "data:text/plain;base64,..." }).bannerUrl).toBeUndefined();
    });

    it("drops svg+xml, matching the avatar policy", () => {
      // SVG can carry script and external references; normalizeAvatarUrl has
      // always excluded it and the banner allowlist must not disagree.
      expect(
        validateProfileMeta({
          bannerUrl: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=",
        }).bannerUrl
      ).toBeUndefined();
      expect(
        validateProfileMeta({
          bannerUrl: "data:image/svg+xml,%3Csvg%3E%3C/svg%3E",
        }).bannerUrl
      ).toBeUndefined();
    });

    it("drops non-base64 and malformed data: images", () => {
      expect(
        validateProfileMeta({ bannerUrl: "data:image/png,notbase64" }).bannerUrl
      ).toBeUndefined();
      expect(
        validateProfileMeta({ bannerUrl: "data:image/png;base64,ab cd" })
          .bannerUrl
      ).toBeUndefined();
    });

    it("accepts every raster type the avatar allowlist accepts", () => {
      for (const type of ["png", "jpeg", "jpg", "gif", "webp", "avif"]) {
        const url = `data:image/${type};base64,iVBORw0KGgo=`;
        expect(validateProfileMeta({ bannerUrl: url }).bannerUrl).toBe(url);
      }
    });

    it("drops URLs over 1.5 MB", () => {
      const longUrl = "data:image/png;base64," + "a".repeat(1_500_001);
      expect(validateProfileMeta({ bannerUrl: longUrl }).bannerUrl).toBeUndefined();
    });

    it("accepts URLs up to 1.5 MB", () => {
      const url = "data:image/png;base64," + "a".repeat(1_500_000 - 22);
      expect(validateProfileMeta({ bannerUrl: url }).bannerUrl).toBe(url);
    });

    it("ignores non-string URLs", () => {
      expect(validateProfileMeta({ bannerUrl: 123 as any }).bannerUrl).toBeUndefined();
    });
  });

  describe("combined validation", () => {
    it("validates all fields simultaneously", () => {
      const result = validateProfileMeta({
        tagText: "MOD",
        tagTextColor: "#ffffff",
        tagChipColor: "#000000",
        bio: "A moderator",
        nameEffect: "glow",
        bannerUrl: "data:image/png;base64,iVBORw0KGgo=",
      });

      expect(result.tagText).toBe("MOD");
      expect(result.tagTextColor).toBe("#ffffff");
      expect(result.tagChipColor).toBe("#000000");
      expect(result.bio).toBe("A moderator");
      expect(result.nameEffect).toBe("glow");
      expect(result.bannerUrl).toBe("data:image/png;base64,iVBORw0KGgo=");
    });

    it("drops only invalid fields, keeps valid ones", () => {
      const result = validateProfileMeta({
        tagText: "MOD",
        tagTextColor: "invalid",
        tagChipColor: "#000000",
        bio: "A moderator",
        nameEffect: "invalid-effect",
      });

      expect(result.tagText).toBe("MOD");
      expect(result.tagTextColor).toBeUndefined();
      expect(result.tagChipColor).toBe("#000000");
      expect(result.bio).toBe("A moderator");
      expect(result.nameEffect).toBeUndefined();
    });

    it("returns empty object for all-invalid input", () => {
      const result = validateProfileMeta({
        tagText: "A",
        tagTextColor: "red",
        nameEffect: "blink",
      });

      expect(Object.keys(result).length).toBe(0);
    });
  });
});
