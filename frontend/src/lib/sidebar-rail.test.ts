import { describe, expect, it } from "vitest";
import {
  HOLD_SLOP_PX,
  RoomPictureUrls,
  holdRelease,
  pressMove,
  badgeText,
  clampMenu,
  dmMenuActions,
  dmSections,
  menuFocusIndex,
  moveStep,
  railPill,
  roomInitials,
  sidebarColumn,
  timeAgo,
} from "./sidebar-rail";

describe("which column the sidebar shows", () => {
  const rooms = ["r1", "r2"];

  it("shows the conversations when direct messages is selected, whatever is open", () => {
    expect(sidebarColumn("dms", "r1", rooms)).toEqual({ kind: "dms" });
    expect(sidebarColumn("dms", null, rooms)).toEqual({ kind: "dms" });
  });

  it("shows the open room's channels", () => {
    expect(sidebarColumn("rooms", "r2", rooms)).toEqual({ kind: "room", roomCode: "r2" });
  });

  it("lists every room when none is open, or the open one is a conversation", () => {
    expect(sidebarColumn("rooms", null, rooms)).toEqual({ kind: "rooms" });
    expect(sidebarColumn("rooms", "dm-abc", rooms)).toEqual({ kind: "rooms" });
  });
});

describe("room tile letters", () => {
  it("takes the first letter of the first two words", () => {
    expect(roomInitials("awful devs")).toBe("AD");
    expect(roomInitials("friday  night games")).toBe("FN");
    expect(roomInitials("team-alpha")).toBe("TA");
  });

  it("takes the first two letters of a single word", () => {
    expect(roomInitials("bookclub")).toBe("BO");
    expect(roomInitials("x")).toBe("X");
  });

  it("never splits an emoji", () => {
    expect(roomInitials("👨‍👩‍👧 family")).toBe("👨‍👩‍👧F");
  });

  it("falls back for a room with no name", () => {
    expect(roomInitials("   ", "abcdef")).toBe("AB");
    expect(roomInitials("", "")).toBe("?");
  });
});

describe("badges and the rail pill", () => {
  it("caps the count at three characters", () => {
    expect(badgeText(7)).toBe("7");
    expect(badgeText(99)).toBe("99");
    expect(badgeText(100)).toBe("99+");
  });

  it("is tall when selected, a dot when unread, absent otherwise", () => {
    expect(railPill(true, 5)).toBe("selected");
    expect(railPill(false, 5)).toBe("unread");
    expect(railPill(false, 0)).toBe("none");
  });
});

describe("time since activity", () => {
  const now = 1_000_000_000;
  it("reads in minutes, hours, then days", () => {
    expect(timeAgo(now - 10_000, now)).toBe("just now");
    expect(timeAgo(now - 5 * 60_000, now)).toBe("5m ago");
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe("3h ago");
    expect(timeAgo(now - 49 * 3_600_000, now)).toBe("2d ago");
  });
});

describe("grouping the conversations", () => {
  const e = (peerId: string, extra: object = {}) => ({ peerId, ...extra });

  it("puts accepted first, then requests, then the blocked, keeping order within each", () => {
    const sections = dmSections([
      e("req1", { request: true }),
      e("a"),
      e("blk", { blocked: true }),
      e("b"),
      e("blockedRequest", { request: true, blocked: true }),
    ]);
    expect(sections.map((s) => [s.title, s.entries.map((x) => x.peerId)])).toEqual([
      [null, ["a", "b"]],
      ["Requests", ["req1"]],
      ["Blocked", ["blk", "blockedRequest"]],
    ]);
  });

  it("leaves empty sections out", () => {
    expect(dmSections([e("a")]).map((s) => s.title)).toEqual([null]);
    expect(dmSections([])).toEqual([]);
  });
});

describe("a conversation's menu", () => {
  it("offers add, block and remove for a stranger", () => {
    expect(dmMenuActions("p", { blocked: false, inPhonebook: false }).map((a) => a.type)).toEqual([
      "add",
      "block",
      "removeConversation",
    ]);
  });

  it("offers removal from the phonebook for a contact", () => {
    expect(dmMenuActions("p", { blocked: false, inPhonebook: true }).map((a) => a.type)).toEqual([
      "removePhonebook",
      "block",
      "removeConversation",
    ]);
  });

  it("does not offer adding someone blocked, and offers unblock", () => {
    expect(dmMenuActions("p", { blocked: true, inPhonebook: false }).map((a) => a.type)).toEqual([
      "unblock",
      "removeConversation",
    ]);
  });
});

describe("moving an item one step", () => {
  it("moves up and down", () => {
    expect(moveStep(["a", "b", "c"], "b", -1)).toEqual(["b", "a", "c"]);
    expect(moveStep(["a", "b", "c"], "b", 1)).toEqual(["a", "c", "b"]);
  });

  it("refuses past either end, or an unknown id", () => {
    expect(moveStep(["a", "b"], "a", -1)).toBeNull();
    expect(moveStep(["a", "b"], "b", 1)).toBeNull();
    expect(moveStep(["a", "b"], "z", 1)).toBeNull();
  });
});

describe("menus", () => {
  const viewport = { width: 400, height: 300 };
  const size = { width: 160, height: 100 };

  it("stays inside the viewport", () => {
    expect(clampMenu(390, 290, size, viewport)).toEqual({ x: 232, y: 192 });
    expect(clampMenu(-20, -5, size, viewport)).toEqual({ x: 8, y: 8 });
    expect(clampMenu(50, 60, size, viewport)).toEqual({ x: 50, y: 60 });
  });

  it("moves focus with the arrows, wrapping, and jumps with Home and End", () => {
    expect(menuFocusIndex("ArrowDown", -1, 3)).toBe(0);
    expect(menuFocusIndex("ArrowDown", 2, 3)).toBe(0);
    expect(menuFocusIndex("ArrowUp", 0, 3)).toBe(2);
    expect(menuFocusIndex("ArrowUp", -1, 3)).toBe(2);
    expect(menuFocusIndex("Home", 2, 3)).toBe(0);
    expect(menuFocusIndex("End", 0, 3)).toBe(2);
    expect(menuFocusIndex("Tab", 0, 3)).toBeNull();
    expect(menuFocusIndex("ArrowDown", 0, 0)).toBeNull();
  });
});

describe("holding a room tile on a touch screen", () => {
  it("a finger that moves before the hold is a swipe, and scrolls", () => {
    expect(pressMove(HOLD_SLOP_PX)).toBe("wait");
    expect(pressMove(HOLD_SLOP_PX + 1)).toBe("swipe");
  });

  it("after the hold, moving drops the tile where it went, and not moving opens the menu", () => {
    expect(holdRelease(true)).toBe("drop");
    expect(holdRelease(false)).toBe("menu");
  });
});

describe("room pictures on the rail", () => {
  function setup() {
    let n = 0;
    const revoked: string[] = [];
    const urls = new RoomPictureUrls(
      () => `blob:${++n}`,
      (url) => revoked.push(url)
    );
    return { urls, revoked };
  }

  it("uses an external picture as it is, and a local upload through one blob URL", () => {
    const { urls, revoked } = setup();
    const data = new ArrayBuffer(4);
    const rooms = [
      { roomCode: "a", pfpURL: "https://example.test/a.gif" },
      { roomCode: "b", pfpData: data },
      { roomCode: "c" },
    ];
    const first = urls.sync(rooms);
    expect([...first]).toEqual([
      ["a", "https://example.test/a.gif"],
      ["b", "blob:1"],
    ]);
    // The same upload keeps its URL: nothing is made or revoked again.
    expect(urls.sync(rooms).get("b")).toBe("blob:1");
    expect(revoked).toEqual([]);
  });

  it("revokes the old URL when the upload changes, the room goes, or the rail is done", () => {
    const { urls, revoked } = setup();
    urls.sync([{ roomCode: "b", pfpData: new ArrayBuffer(1) }, { roomCode: "c", pfpData: new ArrayBuffer(1) }]);
    expect(urls.sync([{ roomCode: "b", pfpData: new ArrayBuffer(2) }]).get("b")).toBe("blob:3");
    expect(revoked.sort()).toEqual(["blob:1", "blob:2"]);
    urls.dispose();
    expect(revoked).toContain("blob:3");
  });

  it("prefers the external picture, letting go of an upload it replaced", () => {
    const { urls, revoked } = setup();
    urls.sync([{ roomCode: "b", pfpData: new ArrayBuffer(1) }]);
    expect(urls.sync([{ roomCode: "b", pfpURL: "https://example.test/b.png" }]).get("b")).toBe(
      "https://example.test/b.png"
    );
    expect(revoked).toEqual(["blob:1"]);
  });
});
