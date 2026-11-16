import { describe, expect, it } from "vitest";
import { shouldWithholdVoice } from "./voice-withhold";

const ANA = "did:key:z6MkAna";
const BEN = "did:key:z6MkBen";

describe("who gets no voice", () => {
  it("sends to everyone when nobody is withheld, named or not", () => {
    expect(shouldWithholdVoice(new Set(), ANA)).toBe(false);
    expect(shouldWithholdVoice(new Set(), null)).toBe(false);
  });

  it("withholds from the chosen person only", () => {
    const withheld = new Set([ANA]);
    expect(shouldWithholdVoice(withheld, ANA)).toBe(true);
    expect(shouldWithholdVoice(withheld, BEN)).toBe(false);
  });

  it("sends nothing to a peer not named yet while anyone is withheld", () => {
    const withheld = new Set([ANA]);
    expect(shouldWithholdVoice(withheld, null)).toBe(true);
    expect(shouldWithholdVoice(withheld, "12D3KooWpeer")).toBe(true);
  });
});
