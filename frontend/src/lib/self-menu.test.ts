import { describe, expect, it } from "vitest";
import { SELF_MENU, profileScopeFor } from "./self-menu";

describe("your own entry's menu", () => {
  it("offers your profile, its settings and your ID, in that order", () => {
    expect(SELF_MENU.map((i) => i.action)).toEqual(["profile", "edit", "copyId"]);
    expect(SELF_MENU.map((i) => i.label)).toEqual(["View my profile", "Edit profile", "Copy my ID"]);
  });

  it("edits the room's own profile only in a protected room", () => {
    expect(profileScopeFor("rd2_abc")).toBe("rd2_abc");
    expect(profileScopeFor("abc-def")).toBeNull();
    expect(profileScopeFor("dm-xyz")).toBeNull();
    expect(profileScopeFor(null)).toBeNull();
    expect(profileScopeFor(undefined)).toBeNull();
  });
});
