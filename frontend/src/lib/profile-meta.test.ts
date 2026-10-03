import { describe, it, expect } from "vitest";
import { validateProfileMeta } from "./profile-meta";
import { wireToModel, modelToWire } from "./name-effect";

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

    it("preserves linked banners and GIFs through a serialized profile", () => {
      for (const url of ["http://example.com/banner.jpg", "https://example.com/banner.gif?size=medium"]) {
        const received = JSON.parse(JSON.stringify({ bannerUrl: url, bio: "Hello" }));
        expect(validateProfileMeta(received)).toEqual({ bannerUrl: url, bio: "Hello" });
      }
    });

    it("drops invalid URLs and non-image data", () => {
      for (const url of ["javascript:alert(1)", "blob:https://example.com/local-only", "file:///banner.png", "not a url"]) {
        expect(validateProfileMeta({ bannerUrl: url }).bannerUrl).toBeUndefined();
      }
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

    it("drops an inline banner that claims more than 4096 px a side", () => {
      const bomb = "data:image/gif;base64,R0lGODlh/z//P4AAAAAAAP///ywAAAAA/z//PwACAkwBADs=";
      expect(validateProfileMeta({ bannerUrl: bomb }).bannerUrl).toBeUndefined();
      const banner = "data:image/gif;base64,R0lGODlhSANoAYAAAAAAAP///ywAAAAASANoAQACAkwBADs=";
      expect(validateProfileMeta({ bannerUrl: banner }).bannerUrl).toBe(banner);
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

  describe("nameShimmer and nameGlow boolean fields", () => {
    it("accepts boolean nameShimmer", () => {
      expect(validateProfileMeta({ nameShimmer: true }).nameShimmer).toBe(
        true
      );
      expect(validateProfileMeta({ nameShimmer: false }).nameShimmer).toBe(
        false
      );
    });

    it("accepts boolean nameGlow", () => {
      expect(validateProfileMeta({ nameGlow: true }).nameGlow).toBe(true);
      expect(validateProfileMeta({ nameGlow: false }).nameGlow).toBe(false);
    });

    it("drops non-boolean nameShimmer", () => {
      expect(validateProfileMeta({ nameShimmer: "true" as any }).nameShimmer).toBeUndefined();
      expect(validateProfileMeta({ nameShimmer: 1 as any }).nameShimmer).toBeUndefined();
      expect(validateProfileMeta({ nameShimmer: null as any }).nameShimmer).toBeUndefined();
    });

    it("drops non-boolean nameGlow", () => {
      expect(validateProfileMeta({ nameGlow: "true" as any }).nameGlow).toBeUndefined();
      expect(validateProfileMeta({ nameGlow: 1 as any }).nameGlow).toBeUndefined();
      expect(validateProfileMeta({ nameGlow: null as any }).nameGlow).toBeUndefined();
    });

    it("accepts both new fields together", () => {
      const result = validateProfileMeta({
        nameShimmer: true,
        nameGlow: false,
        nameEffect: "gradient",
      });
      expect(result.nameShimmer).toBe(true);
      expect(result.nameGlow).toBe(false);
      expect(result.nameEffect).toBe("gradient");
    });
  });

  describe("wire <-> model conversions", () => {
    describe("legacy compatibility - only nameEffect", () => {
      it("converts nameEffect: 'none' to model correctly", () => {
        const model = wireToModel("none", undefined, undefined);
        expect(model).toEqual({ fill: "none", shimmer: false, glow: false });
      });

      it("converts nameEffect: 'gradient' to model correctly", () => {
        const model = wireToModel("gradient", undefined, undefined);
        expect(model).toEqual({
          fill: "gradient",
          shimmer: false,
          glow: false,
        });
      });

      it("converts nameEffect: 'shimmer' to model correctly", () => {
        const model = wireToModel("shimmer", undefined, undefined);
        expect(model).toEqual({
          fill: "gradient",
          shimmer: true,
          glow: false,
        });
      });

      it("converts nameEffect: 'glow' to model correctly", () => {
        const model = wireToModel("glow", undefined, undefined);
        expect(model).toEqual({ fill: "none", shimmer: false, glow: true });
      });

      it("converts nameEffect: 'rainbow' to model correctly", () => {
        const model = wireToModel("rainbow", undefined, undefined);
        expect(model).toEqual({
          fill: "rainbow",
          shimmer: false,
          glow: false,
        });
      });
    });

    describe("new fields override legacy", () => {
      it("new nameShimmer overrides legacy shimmer detection", () => {
        // nameEffect: "shimmer" would set shimmer: true, but explicit false overrides
        const model = wireToModel("shimmer", false, undefined);
        expect(model.shimmer).toBe(false);
      });

      it("new nameGlow overrides legacy glow detection", () => {
        const model = wireToModel("glow", undefined, false);
        expect(model.glow).toBe(false);
      });

      it("new fields compose together", () => {
        // A gradient with both shimmer and glow
        const model = wireToModel("gradient", true, true);
        expect(model).toEqual({
          fill: "gradient",
          shimmer: true,
          glow: true,
        });
      });
    });

    describe("model -> wire round trip", () => {
      it("round-trips 'none' to 'none'", () => {
        const model = { fill: "none" as const, shimmer: false, glow: false };
        const wire = modelToWire(model);
        expect(wire.nameEffect).toBe("none");
        expect(wire.nameShimmer).toBe(false);
        expect(wire.nameGlow).toBe(false);
      });

      it("round-trips gradient alone to 'gradient'", () => {
        const model = { fill: "gradient" as const, shimmer: false, glow: false };
        const wire = modelToWire(model);
        expect(wire.nameEffect).toBe("gradient");
        expect(wire.nameShimmer).toBe(false);
        expect(wire.nameGlow).toBe(false);
      });

      it("round-trips gradient+shimmer to 'shimmer'", () => {
        const model = { fill: "gradient" as const, shimmer: true, glow: false };
        const wire = modelToWire(model);
        expect(wire.nameEffect).toBe("shimmer");
        expect(wire.nameShimmer).toBe(true);
        expect(wire.nameGlow).toBe(false);
      });

      it("round-trips glow alone to 'glow'", () => {
        const model = { fill: "none" as const, shimmer: false, glow: true };
        const wire = modelToWire(model);
        expect(wire.nameEffect).toBe("glow");
        expect(wire.nameShimmer).toBe(false);
        expect(wire.nameGlow).toBe(true);
      });

      it("round-trips rainbow to 'rainbow'", () => {
        const model = { fill: "rainbow" as const, shimmer: false, glow: false };
        const wire = modelToWire(model);
        expect(wire.nameEffect).toBe("rainbow");
        expect(wire.nameShimmer).toBe(false);
        expect(wire.nameGlow).toBe(false);
      });

      it("round-trips gradient+glow to 'gradient' (gradient fill takes precedence)", () => {
        // When we have gradient + glow, we write "gradient" to the wire,
        // because gradient fill is the primary visual. The new fields preserve full info.
        const model = { fill: "gradient" as const, shimmer: false, glow: true };
        const wire = modelToWire(model);
        expect(wire.nameEffect).toBe("gradient");
        expect(wire.nameShimmer).toBe(false);
        expect(wire.nameGlow).toBe(true);
      });

      it("round-trips gradient+shimmer+glow to 'shimmer'", () => {
        const model = { fill: "gradient" as const, shimmer: true, glow: true };
        const wire = modelToWire(model);
        expect(wire.nameEffect).toBe("shimmer");
        expect(wire.nameShimmer).toBe(true);
        expect(wire.nameGlow).toBe(true);
      });

      it("old client sees gradient+glow as 'gradient' (closest approximation)", () => {
        // When an old client sees this, they get nameEffect: "gradient" (the fill)
        // and ignore nameShimmer/nameGlow, rendering just the gradient without glow
        const model = { fill: "gradient" as const, shimmer: false, glow: true };
        const wire = modelToWire(model);
        // Old client sees nameEffect = "gradient", which shows the right colors
        expect(wire.nameEffect).toBe("gradient");
      });

      it("old client sees gradient+shimmer as 'shimmer'", () => {
        const model = { fill: "gradient" as const, shimmer: true, glow: false };
        const wire = modelToWire(model);
        // Old client sees nameEffect = "shimmer", which is correct
        expect(wire.nameEffect).toBe("shimmer");
      });
    });

    describe("legacy profile persistence", () => {
      it("legacy gradient profile stays gradient when round-tripped", () => {
        // Wire format from old client: just nameEffect: "gradient"
        const model = wireToModel("gradient", undefined, undefined);
        const wire = modelToWire(model);
        expect(wire.nameEffect).toBe("gradient");
      });

      it("legacy shimmer profile stays shimmer when round-tripped", () => {
        const model = wireToModel("shimmer", undefined, undefined);
        const wire = modelToWire(model);
        expect(wire.nameEffect).toBe("shimmer");
      });

      it("legacy glow profile stays glow when round-tripped", () => {
        const model = wireToModel("glow", undefined, undefined);
        const wire = modelToWire(model);
        expect(wire.nameEffect).toBe("glow");
      });

      it("legacy rainbow profile stays rainbow when round-tripped", () => {
        const model = wireToModel("rainbow", undefined, undefined);
        const wire = modelToWire(model);
        expect(wire.nameEffect).toBe("rainbow");
      });
    });
  });
});

describe("a name effect survives the trip to another device", () => {
  // The validator is the narrow point between two people. It drops anything
  // it does not allowlist, and a dropped field is SILENT: the sender keeps
  // rendering from their own profileStore and looks fine, so only the
  // receiver sees the effect go missing. That is the failure this pins,
  // because catching it by hand needs a second device.
  const fills = ["none", "gradient", "rainbow"] as const;
  for (const fill of fills) {
    for (const shimmer of [false, true]) {
      for (const glow of [false, true]) {
        it(`carries fill=${fill} shimmer=${shimmer} glow=${glow}`, () => {
          const wire = modelToWire({ fill, shimmer, glow });
          const validated = validateProfileMeta({
            nameEffect: wire.nameEffect,
            nameShimmer: wire.nameShimmer,
            nameGlow: wire.nameGlow,
          });
          expect(
            wireToModel(
              validated.nameEffect,
              validated.nameShimmer,
              validated.nameGlow
            )
          ).toEqual({ fill, shimmer, glow });
        });
      }
    }
  }
});
