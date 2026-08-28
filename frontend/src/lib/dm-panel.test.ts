import { beforeEach, describe, expect, it } from "vitest";
import { MessageType, type Message } from "./types/message";
import {
  appendToDmPanel,
  dmPanel,
  dmPanelIsShowing,
} from "./dm-panel.svelte";

const DM_A = "dm-aaaa";
const DM_B = "dm-bbbb";
const ROOM = "cats-and-dogs";

function msg(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    roomCode: DM_A,
    senderId: "did:key:them",
    senderName: "Them",
    timestamp: 1,
    lamport: 1,
    type: MessageType.Text,
    content: "hello",
    attachments: [],
    ...over,
  };
}

describe("the floating DM panel's message list", () => {
  beforeEach(() => {
    dmPanel.peerId = "did:key:them";
    dmPanel.roomCode = DM_A;
    dmPanel.messages = [];
    dmPanel.minimized = false;
  });

  it("takes messages for the conversation it is showing", () => {
    appendToDmPanel(msg());
    expect(dmPanel.messages.map((m) => m.id)).toEqual(["m1"]);
  });

  it("refuses another conversation's messages", () => {
    // The bug this panel replaces: a DM keyed by the hash of two DIDs, rendered
    // in a pane keyed to the room the VIEW was on. The keys can never match, so
    // every message was filtered out. Keying on the room code, in one place,
    // is what makes that impossible here.
    appendToDmPanel(msg({ id: "other-dm", roomCode: DM_B }));
    appendToDmPanel(msg({ id: "a-room", roomCode: ROOM }));
    expect(dmPanel.messages).toEqual([]);
  });

  it("takes nothing while closed", () => {
    dmPanel.roomCode = null;
    appendToDmPanel(msg());
    expect(dmPanel.messages).toEqual([]);
  });

  it("holds one copy of a message delivered twice", () => {
    appendToDmPanel(msg());
    appendToDmPanel(msg());
    expect(dmPanel.messages).toHaveLength(1);
  });

  it("orders by lamport, whatever order messages arrive in", () => {
    appendToDmPanel(msg({ id: "third", lamport: 3 }));
    appendToDmPanel(msg({ id: "first", lamport: 1 }));
    appendToDmPanel(msg({ id: "second", lamport: 2 }));
    expect(dmPanel.messages.map((m) => m.id)).toEqual([
      "first",
      "second",
      "third",
    ]);
  });

  it("breaks a lamport tie on sender, so both sides agree on the order", () => {
    appendToDmPanel(msg({ id: "b", lamport: 5, senderId: "did:key:b" }));
    appendToDmPanel(msg({ id: "a", lamport: 5, senderId: "did:key:a" }));
    expect(dmPanel.messages.map((m) => m.id)).toEqual(["a", "b"]);
  });
});

describe("dmPanelIsShowing", () => {
  beforeEach(() => {
    dmPanel.roomCode = DM_A;
    dmPanel.minimized = false;
  });

  it("is true only for the conversation actually on screen", () => {
    expect(dmPanelIsShowing(DM_A)).toBe(true);
    expect(dmPanelIsShowing(DM_B)).toBe(false);
  });

  it("is false while minimized: nobody has read a collapsed panel", () => {
    dmPanel.minimized = true;
    expect(dmPanelIsShowing(DM_A)).toBe(false);
  });

  it("is false while closed", () => {
    dmPanel.roomCode = null;
    expect(dmPanelIsShowing(DM_A)).toBe(false);
  });
});
