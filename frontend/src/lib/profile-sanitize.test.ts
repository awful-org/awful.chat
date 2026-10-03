import { describe, expect, it } from "vitest";
import { sanitizePeerProfile } from "./profile-sanitize";
import type { PeerProfile } from "./storage";

const base: PeerProfile = { did: "did:key:zBob", isMe: false, nickname: "Bob", updatedAt: 1 };

describe("sanitizePeerProfile", () => {
  it("drops a colour carrying CSS, and style values that are not colours", () => {
    const p = sanitizePeerProfile({
      ...base,
      color: "red;background:url(https://x/beacon);position:fixed;inset:0",
      tagTextColor: "#fff;position:fixed",
      tagChipColor: "#112233",
    });
    expect(p.color).toBeUndefined();
    expect(p.tagTextColor).toBeUndefined();
    expect(p.tagChipColor).toBe("#112233");
  });

  it("drops an avatar or banner that is not a safe image URL", () => {
    const p = sanitizePeerProfile({ ...base, pfpURL: "javascript:alert(1)", bannerURL: "data:text/html,<script>" });
    expect(p.pfpURL).toBeUndefined();
    expect(p.bannerURL).toBeUndefined();
  });

  it("drops a stored avatar or banner that claims a gigapixel", () => {
    // Stored by a build that let it through: it must not come back on load.
    const bomb = "data:image/gif;base64,R0lGODlh/z//P4AAAAAAAP///ywAAAAA/z//PwACAkwBADs=";
    const p = sanitizePeerProfile({ ...base, pfpURL: bomb, bannerURL: bomb });
    expect(p.pfpURL).toBeUndefined();
    expect(p.bannerURL).toBeUndefined();
    expect(p.nickname).toBe("Bob");
  });

  it("keeps what is valid, and everything it does not judge", () => {
    const p = sanitizePeerProfile({ ...base, color: "#aabbcc", inboxOff: true, tagText: "dev" });
    expect(p).toMatchObject({ did: base.did, nickname: "Bob", color: "#aabbcc", inboxOff: true, tagText: "DEV", updatedAt: 1 });
  });

  it("cleans the name like a wire name", () => {
    const p = sanitizePeerProfile({ ...base, nickname: "Bob‮\u0000" + "x".repeat(200) });
    expect(p.nickname.length).toBeLessThanOrEqual(64);
    expect(p.nickname).not.toMatch(/[‮\u0000]/);
  });
});
