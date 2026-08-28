import { beforeEach, describe, expect, it, vi } from "vitest";
import { MessageType, type Message } from "./types/message";

const notified: Array<{
  title: string;
  body: string;
  tag: string;
  viewingConversation?: boolean;
  data?: { roomCode: string; dmPeerDid?: string };
}> = [];

vi.mock("./notify.svelte", () => ({
  notifyMessage: (opts: (typeof notified)[number]) => notified.push(opts),
}));

vi.mock("./plugins/registry", () => ({
  getManifest: (id: string) => (id === "dice" ? { name: "Dice" } : undefined),
}));

vi.mock("./rooms.svelte", () => ({
  roomsStore: {
    rooms: [{ roomCode: "room-a", name: "The Room" }],
    dmRooms: [],
  },
}));

const { announceMessage, _resetAnnounced } = await import("./announce");

const ME = "did:key:me";
const THEM = "did:key:them";

const ctx = {
  selfIds: [ME, "12D3KooWme"],
  uiRoomCode: null as string | null,
  resolveName: (did: string) => (did === ME ? "Me" : "Them"),
};

function msg(over: Partial<Message> = {}): Message {
  return {
    id: "m1",
    roomCode: "room-a",
    senderId: THEM,
    senderName: "Them",
    timestamp: 1,
    lamport: 1,
    type: MessageType.Text,
    content: "hello",
    attachments: [],
    ...over,
  };
}

describe("announceMessage", () => {
  beforeEach(() => {
    notified.length = 0;
    ctx.uiRoomCode = null;
    _resetAnnounced();
  });

  it("announces a new room message under the message's own room name", () => {
    announceMessage(msg(), ctx);
    expect(notified).toHaveLength(1);
    expect(notified[0].title).toBe("The Room");
    expect(notified[0].body).toBe("Them: hello");
    expect(notified[0].tag).toBe("room:room-a");
    expect(notified[0].data).toEqual({
      roomCode: "room-a",
      dmPeerDid: undefined,
    });
  });

  it("announces the same message once, however many times it is delivered", () => {
    // The whole point: room chat arrives over pubsub AND as a direct copy.
    announceMessage(msg(), ctx);
    announceMessage(msg(), ctx);
    expect(notified).toHaveLength(1);
  });

  it("keeps announcing distinct messages after a duplicate", () => {
    announceMessage(msg({ id: "m1" }), ctx);
    announceMessage(msg({ id: "m1" }), ctx);
    announceMessage(msg({ id: "m2" }), ctx);
    expect(notified.map((n) => n.body)).toEqual(["Them: hello", "Them: hello"]);
  });

  it("stays quiet for your own message coming back through sync", () => {
    announceMessage(msg({ senderId: ME }), ctx);
    announceMessage(msg({ id: "m2", senderId: "12D3KooWme" }), ctx);
    expect(notified).toHaveLength(0);
  });

  it("stays quiet for reactions and plugin updates", () => {
    announceMessage(msg({ type: MessageType.Reaction }), ctx);
    announceMessage(msg({ id: "m2", type: MessageType.PluginUpdate }), ctx);
    expect(notified).toHaveLength(0);
  });

  it("titles a mention with the sender, not the room", () => {
    announceMessage(msg({ content: `hey @[${ME}] look` }), ctx);
    expect(notified[0].title).toBe("Them mentioned you");
    expect(notified[0].body).toBe("Them: hey @Me look");
  });

  it("uses the DM shape for a dm- room and routes a click to the sender", () => {
    announceMessage(msg({ roomCode: "dm-abc" }), ctx);
    expect(notified[0].title).toBe("Them");
    expect(notified[0].body).toBe("hello");
    expect(notified[0].tag).toBe("dm:dm-abc");
    expect(notified[0].data).toEqual({
      roomCode: "dm-abc",
      dmPeerDid: THEM,
    });
  });

  it("names the plugin in a plugin card announcement", () => {
    announceMessage(
      msg({
        type: MessageType.PluginCard,
        content: JSON.stringify({ pluginId: "dice" }),
      }),
      ctx
    );
    expect(notified[0].body).toBe("Them: posted a Dice");
  });

  it("reports the conversation on screen so the sound rule can stay quiet", () => {
    ctx.uiRoomCode = "room-a";
    announceMessage(msg(), ctx);
    expect(notified[0].viewingConversation).toBe(true);

    ctx.uiRoomCode = "room-b";
    announceMessage(msg({ id: "m2" }), ctx);
    expect(notified[1].viewingConversation).toBe(false);
  });

  it("falls back to the room code for a room it does not know", () => {
    announceMessage(msg({ roomCode: "room-unknown" }), ctx);
    expect(notified[0].title).toBe("room-unknown");
  });

  it("describes a file message with no text", () => {
    announceMessage(msg({ type: MessageType.File, content: "" }), ctx);
    expect(notified[0].body).toBe("Them: [file]");
  });
});
