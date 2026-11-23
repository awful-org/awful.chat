import { describe, expect, it } from "vitest";
import {
  callPlaceLabel,
  channelHeading,
  channelModeToStore,
  composerPlaceholder,
  notifyLabel,
  notifyMenuItems,
  stageCall,
} from "./channel-ui";

const general = { id: "", name: "general" };
const random = { id: "aaaaaaaaaaaaaaaa", name: "random" };

describe("the channel in the chat header", () => {
  it("is not shown in a room with only its original chat", () => {
    expect(channelHeading([general], "")).toBeNull();
    expect(channelHeading([], "")).toBeNull();
  });

  it("names the channel on screen once there is a choice, the original included", () => {
    expect(channelHeading([general, random], random.id)).toBe("random");
    expect(channelHeading([general, random], "")).toBe("general");
  });
});

describe("the composer placeholder", () => {
  it("is unchanged without channels, and names the channel with them", () => {
    expect(composerPlaceholder(null, false)).toBe("Type a message...");
    expect(composerPlaceholder(null, true)).toBe("Message...");
    expect(composerPlaceholder("random", false)).toBe("Message #random");
  });
});

describe("the header bell", () => {
  it("says what it acts on", () => {
    expect(notifyLabel("muted", null)).toBe("Notifications: Muted");
    expect(notifyLabel("mentions", "random")).toBe("Notifications for #random: Mentions only");
  });

  it("stores a channel mode only while it differs from the room's", () => {
    expect(channelModeToStore("muted", "muted")).toBeNull();
    expect(channelModeToStore("all", "muted")).toBe("all");
  });
});

describe("a channel's notification menu", () => {
  it("offers mute and mentions for a loud channel", () => {
    const items = notifyMenuItems({ isDefault: false, mode: "all", own: null, roomMode: "all" });
    expect(items.map((i) => [i.label, i.mode])).toEqual([
      ["Mute channel", "muted"],
      ["Mentions only", "mentions"],
    ]);
  });

  it("unmutes a channel muted on its own back to following its room", () => {
    const items = notifyMenuItems({ isDefault: false, mode: "muted", own: "muted", roomMode: "mentions" });
    expect(items.map((i) => [i.label, i.mode])).toEqual([
      ["Unmute channel", null],
      ["Mentions only", null],
      ["Use room setting", null],
    ]);
  });

  it("unmutes a channel of a muted room by giving it a mode of its own", () => {
    const items = notifyMenuItems({ isDefault: false, mode: "muted", own: null, roomMode: "muted" });
    expect(items[0]).toEqual({ id: "unmute", label: "Unmute channel", mode: "all" });
  });

  it("offers all messages back from mentions only", () => {
    const items = notifyMenuItems({ isDefault: false, mode: "mentions", own: "mentions", roomMode: "all" });
    expect(items.map((i) => i.id)).toEqual(["mute", "all", "follow"]);
    expect(items.find((i) => i.id === "all")!.mode).toBeNull();
  });

  it("speaks of the room for the original chat, whose mode is the room's", () => {
    const items = notifyMenuItems({ isDefault: true, mode: "muted", own: null, roomMode: "muted" });
    expect(items.map((i) => [i.label, i.mode])).toEqual([
      ["Unmute room", "all"],
      ["Mentions only", "mentions"],
    ]);
    expect(
      notifyMenuItems({ isDefault: true, mode: "all", own: null, roomMode: "all" })[0]
    ).toEqual({ id: "mute", label: "Mute room", mode: "muted" });
  });
});

describe("the call the stage shows", () => {
  it("is ours when it is in the room on screen, whatever its voice channel", () => {
    const mine = { roomCode: "rd2_a", voiceChannel: "cccccccccccccccc" };
    expect(stageCall("rd2_a", mine)).toBe(mine);
  });

  it("is the room's original call otherwise", () => {
    const elsewhere = { roomCode: "rd2_b", voiceChannel: "" };
    expect(stageCall("rd2_a", elsewhere)).toEqual({ roomCode: "rd2_a", voiceChannel: "" });
    expect(stageCall("rd2_a", null)).toEqual({ roomCode: "rd2_a", voiceChannel: "" });
    expect(stageCall(null, elsewhere)).toBeNull();
  });
});

describe("the call status's name for the call", () => {
  it("is the room alone for its original call, and the room and channel otherwise", () => {
    expect(callPlaceLabel("Friends", "", null)).toBe("Friends");
    expect(callPlaceLabel("Friends", "cccccccccccccccc", "gaming")).toBe("Friends · gaming");
    expect(callPlaceLabel("Friends", "cccccccccccccccc", null)).toBe("Friends · voice channel");
  });
});
