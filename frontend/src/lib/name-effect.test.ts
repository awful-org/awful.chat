import { describe, it, expect } from "vitest";
import { nameEffectStyle, wireToModel, modelToWire } from "./name-effect";

describe("nameEffectStyle", () => {
  describe("legacy shimmer - must render exactly as before", () => {
    it("renders legacy shimmer (nameEffect='shimmer', no new booleans) with correct gradient", () => {
      // This test verifies that the EXACT appearance is preserved
      const result = nameEffectStyle("shimmer", "#3b82f6", undefined, undefined);

      // Must have the shimmer class
      expect(result.class).toContain("name-effect-shimmer");

      // Must have background gradient sweep from color through white to color
      expect(result.style).toContain("background:");
      expect(result.style).toContain("linear-gradient");
      expect(result.style).toContain("#3b82f6");
      expect(result.style).toContain("rgba(255,255,255,0.3)");

      // Must have the background-size that lets the keyframes animate
      expect(result.style).toContain("background-size: 200% 100%");

      // Must have background-clip to paint on text
      expect(result.style).toContain("background-clip: text");
      expect(result.style).toContain("-webkit-background-clip: text");
      expect(result.style).toContain("-webkit-text-fill-color: transparent");

      // Must have the shimmer animation
      expect(result.style).toContain("animation:");
      expect(result.style).toContain("shimmer");
      expect(result.style).toContain("3.5s");
      expect(result.style).toContain("steps(50)");
    });

    it("renders legacy shimmer without explicit gradient2/gradient3", () => {
      // Verify the color sweep works without extra stops
      const result = nameEffectStyle("shimmer", "#ff0000");
      expect(result.style).toContain("#ff0000");
      expect(result.style).toContain("rgba(255,255,255,0.3)");
    });
  });

  describe("glow composition", () => {
    it("gradient + glow produces both background-clip fill AND text-shadow", () => {
      const result = nameEffectStyle(
        "gradient",
        "#3b82f6",
        "#7c3aed",
        undefined,
        false, // no shimmer
        true   // glow
      );

      // Must have gradient fill with background-clip
      expect(result.style).toContain("background:");
      expect(result.style).toContain("linear-gradient");
      expect(result.style).toContain("background-clip: text");
      expect(result.style).toContain("-webkit-text-fill-color: transparent");

      // Must ALSO have text-shadow for glow
      expect(result.style).toContain("text-shadow:");
      expect(result.style).toContain("0 0 3px");
      expect(result.style).toContain("#3b82f6");
      expect(result.style).not.toContain("animation:");

      // Must have glow class
      expect(result.class).toContain("name-effect-glow");
      expect(result.class).toContain("name-effect-gradient");
    });

    it("gradient + shimmer + glow produces all three effects", () => {
      const result = nameEffectStyle(
        "gradient",
        "#3b82f6",
        "#7c3aed",
        undefined,
        true, // shimmer
        true  // glow
      );

      // Must have gradient
      expect(result.style).toContain("background:");
      expect(result.style).toContain("background-clip: text");

      // Must have shimmer size for animation
      expect(result.style).toContain("background-size: 200% 100%");

      // Must have glow text-shadow
      expect(result.style).toContain("text-shadow:");

      // Shimmer remains animated; glow stays static and tight.
      expect(result.style).toContain("animation:");
      const animMatch = result.style.match(/animation:\s*([^;]+)/);
      expect(animMatch).toBeTruthy();
      const animations = animMatch![1];
      expect(animations).toContain("shimmer");
      expect(animations).not.toContain("glow");
      expect((result.style.match(/animation:/g) || []).length).toBe(1);
    });
  });

  describe("shimmer without fill (no glow)", () => {
    it("shimmer without fill or glow renders legacy shimmer style", () => {
      const result = nameEffectStyle(
        undefined,
        "#3b82f6",
        undefined,
        undefined,
        true, // shimmer
        false // no glow
      );

      expect(result.style).toContain("background-size: 200% 100%");
      expect(result.style).toContain("background-clip: text");
      expect(result.style).toContain("animation:");
      expect(result.style).toContain("shimmer");
    });
  });

  describe("glow alone", () => {
    it("glow without fill produces only text-shadow", () => {
      const result = nameEffectStyle(
        undefined,
        "#3b82f6",
        undefined,
        undefined,
        false, // no shimmer
        true   // glow
      );

      // Should have text-shadow
      expect(result.style).toContain("text-shadow:");
      expect(result.style).toContain("0 0 3px");

      // Glow stays a tight static halo so it does not bloom into a box around
      // short names while the text is animated by another fill effect.
      expect(result.style).not.toContain("animation:");

      // Should NOT have background-clip (no fill)
      expect(result.style).not.toContain("background-clip:");
      expect(result.style).not.toContain("-webkit-background-clip:");
    });
  });

  describe("glow preserves the selected fill", () => {
    it.each([
      [undefined, false, "#d946ef", "solid"],
      ["gradient", false, "#d946ef", "gradient"],
      ["gradient", true, "#d946ef", "shimmer"],
      ["rainbow", false, "#d946ef", "rainbow"],
    ] as const)(
      "keeps the %s fill and uses the saved colour for its glow",
      (effect, shimmer, color, _label) => {
        const result = nameEffectStyle(
          effect,
          color,
          "#22d3ee",
          undefined,
          shimmer,
          true
        );

        expect(result.class).toContain("name-effect-glow");
        expect(result.style).toContain(`--name-glow-color: ${color}`);

        if (effect === undefined) {
          expect(result.style).toMatch(
            new RegExp(`(?:^|; )color: ${color}(?:;|$)`)
          );
          expect(result.style).not.toContain("background-clip: text");
        } else {
          expect(result.style).toContain("background-clip: text");
        }
      }
    );
  });

  describe("no effects", () => {
    it("no effects returns empty style", () => {
      const result = nameEffectStyle(undefined, "#3b82f6");
      expect(result.style).toBe("");
      expect(result.class).toBe("");
    });

    it("nameEffect='none' returns empty style", () => {
      const result = nameEffectStyle("none", "#3b82f6");
      expect(result.style).toBe("");
      expect(result.class).toBe("");
    });
  });

  describe("missing color", () => {
    it("gradient without color returns empty", () => {
      const result = nameEffectStyle("gradient", undefined);
      expect(result.style).toBe("");
      expect(result.class).toBe("");
    });

    it("glow without color returns empty", () => {
      const result = nameEffectStyle("glow", undefined);
      expect(result.style).toBe("");
      expect(result.class).toBe("");
    });

    it("rainbow without color still renders (rainbow has built-in colors)", () => {
      const result = nameEffectStyle("rainbow", undefined);
      expect(result.style).not.toBe("");
      expect(result.style).toContain("linear-gradient");
    });

    it("shimmer without color returns empty", () => {
      const result = nameEffectStyle("shimmer", undefined);
      expect(result.style).toBe("");
      expect(result.class).toBe("");
    });
  });

  describe("backward compat: legacy profiles without new booleans", () => {
    it("legacy gradient profile unchanged", () => {
      // Old client sent just nameEffect: "gradient"
      const model = wireToModel("gradient", undefined, undefined);
      const wire = modelToWire(model);
      expect(wire.nameEffect).toBe("gradient");
      expect(wire.nameShimmer).toBe(false);
      expect(wire.nameGlow).toBe(false);
    });

    it("legacy shimmer profile unchanged", () => {
      const model = wireToModel("shimmer", undefined, undefined);
      const wire = modelToWire(model);
      expect(wire.nameEffect).toBe("shimmer");
    });

    it("legacy glow profile unchanged", () => {
      const model = wireToModel("glow", undefined, undefined);
      const wire = modelToWire(model);
      expect(wire.nameEffect).toBe("glow");
    });

    it("legacy rainbow profile unchanged", () => {
      const model = wireToModel("rainbow", undefined, undefined);
      const wire = modelToWire(model);
      expect(wire.nameEffect).toBe("rainbow");
    });
  });
});
