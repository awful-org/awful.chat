import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageType, type Message } from "$lib/types/message";
import { appendToDmPanel, dmPanel } from "$lib/dm-panel.svelte";

vi.mock("$lib/storage", async (original) => ({
  ...await original<typeof import("$lib/storage")>(),
  updateMessageStatus: vi.fn(async () => {}),
}));

const { applyMessageStatus } = await import("./transport.svelte");

function own(status: Message["status"]): Message {
  return {
    id: "m1", roomCode: "dm-aaaa", senderId: "did:key:me", senderName: "You",
    timestamp: 1, lamport: 1, type: MessageType.Text, content: "hi", attachments: [], status,
  };
}

/** The panel owns its list, so an ack for a row the pane is not showing has to reach it. */
describe("a DM's status reaching the floating panel", () => {
  beforeEach(() => {
    dmPanel.roomCode = "dm-aaaa";
    dmPanel.messages = [];
  });

  it("advances the panel's copy", () => {
    appendToDmPanel(own("sent"));
    applyMessageStatus("m1", "read");
    expect(dmPanel.messages[0].status).toBe("read");
  });

  it("never moves it backwards on a late ack", () => {
    appendToDmPanel(own("read"));
    applyMessageStatus("m1", "delivered");
    expect(dmPanel.messages[0].status).toBe("read");
  });
});
