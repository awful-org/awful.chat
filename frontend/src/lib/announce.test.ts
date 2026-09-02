import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MessageType, type Message } from "./types/message";

const notified: Array<{
  title: string;
  body: string;
  tag: string;
  viewingConversation?: boolean;
  urgent?: boolean;
  isPreview?: boolean;
  data?: { roomCode: string; dmPeerDid?: string };
}> = [];

const closedTags: string[] = [];

vi.mock("./notify.svelte", () => ({
  notifyMessage: (opts: (typeof notified)[number]) => notified.push(opts),
  closeNotificationsByTag: (tags: string[]) => closedTags.push(...tags),
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

// The ref -> room mapping goes to IndexedDB, which node has none of. What it
// records is asserted in notify-intents.test.ts; here it only has to not fire.
const remembered: Array<[string, string]> = [];
vi.mock("./notify-intents", async (orig) => ({
  ...(await orig<typeof import("./notify-intents")>()),
  rememberRoomRef: (ref: string, roomCode: string) => {
    remembered.push([ref, roomCode]);
    return Promise.resolve();
  },
}));

const { announceMessage, _resetAnnounced, conversationRef } = await import(
  "./announce"
);
const { getRoomNotifyMode, setRoomNotifyMode } = await import(
  "./notify-prefs.svelte"
);

/** Let the burst window close, so anything held back is announced. */
function settle(): void {
  vi.advanceTimersByTime(2500);
}

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
    vi.useFakeTimers();
    notified.length = 0;
    remembered.length = 0;
    closedTags.length = 0;
    ctx.uiRoomCode = null;
    _resetAnnounced();
    setRoomNotifyMode("room-a", "all");
    setRoomNotifyMode("dm-abc", "all");
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("announces a new room message under the message's own room name", () => {
    announceMessage(msg(), ctx);
    expect(notified).toHaveLength(1);
    expect(notified[0].title).toBe("The Room");
    expect(notified[0].body).toBe("Them: hello");
    // The tag and data name the conversation by its opaque ref, never by the
    // room code: both outlive the page inside the browser's notification store.
    const ref = conversationRef("room-a");
    expect(ref).not.toContain("room-a");
    expect(notified[0].tag).toBe(`room:${ref}`);
    expect(notified[0].data).toEqual({
      roomCode: ref,
      dmPeerDid: undefined,
    });
    // ...and the mapping back is recorded, or the click could not route.
    expect(remembered).toEqual([[ref, "room-a"]]);
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
    // The second one lands inside the first's burst window, so it waits for
    // it to close - alone, so it is still announced as itself.
    settle();
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
    expect(notified[0].tag).toBe(`dm:${conversationRef("dm-abc")}`);
    expect(notified[0].data).toEqual({
      roomCode: conversationRef("dm-abc"),
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

    settle();
    ctx.uiRoomCode = "room-b";
    announceMessage(msg({ id: "m2" }), ctx);
    settle();
    expect(notified[1].viewingConversation).toBe(false);
  });

  it("never titles a notification with the room code", () => {
    announceMessage(msg({ roomCode: "room-unknown" }), ctx);
    // A lock-screen title is read by whoever is holding the phone.
    expect(notified[0].title).toBe("New message");
    expect(JSON.stringify(notified[0])).not.toContain("room-unknown");
  });

  it("describes a file message with no text", () => {
    announceMessage(msg({ type: MessageType.File, content: "" }), ctx);
    expect(notified[0].body).toBe("Them: [file]");
  });

  it("collapses a mailbox batch into one notification", () => {
    // A collect hands over everything that arrived while the app was shut.
    // Announced one at a time that is a pocket buzzing five times for what
    // the user will read as one batch.
    for (const id of ["m1", "m2", "m3"]) {
      announceMessage(msg({ id, roomCode: "dm-abc" }), ctx, {
        viaMailbox: true,
      });
    }
    expect(notified).toHaveLength(0);
    settle();
    expect(notified).toHaveLength(1);
    expect(notified[0].title).toBe("Them");
    expect(notified[0].body).toBe("3 new messages");
    expect(notified[0].tag).toBe(`dm:${conversationRef("dm-abc")}`);
    // Not anybody's words, so the hide-preview switch must leave it alone.
    expect(notified[0].isPreview).toBe(false);
  });

  it("collapses a burst that arrives one message at a time", () => {
    announceMessage(msg({ id: "m1" }), ctx);
    // The first is immediate: a live conversation must not feel laggy.
    expect(notified).toHaveLength(1);
    vi.advanceTimersByTime(300);
    announceMessage(msg({ id: "m2" }), ctx);
    vi.advanceTimersByTime(300);
    announceMessage(msg({ id: "m3" }), ctx);
    expect(notified).toHaveLength(1);
    settle();
    expect(notified).toHaveLength(2);
    expect(notified[1].body).toBe("2 new messages");
  });

  it("names no conversation when a burst spans several", () => {
    announceMessage(msg({ id: "m1", roomCode: "room-a" }), ctx, {
      viaMailbox: true,
    });
    announceMessage(msg({ id: "m2", roomCode: "dm-abc" }), ctx, {
      viaMailbox: true,
    });
    settle();
    expect(notified).toHaveLength(1);
    expect(notified[0].title).toBe("2 new messages");
    // Naming one of them would be a guess, and a click has nowhere to route.
    expect(notified[0].data).toBeUndefined();
  });

  it("says nothing at all for a muted conversation", () => {
    setRoomNotifyMode("room-a", "muted");
    announceMessage(msg(), ctx);
    settle();
    expect(notified).toHaveLength(0);
    setRoomNotifyMode("room-a", "all");
  });

  it("keeps mentions in a conversation turned down to mentions", () => {
    setRoomNotifyMode("room-a", "mentions");
    announceMessage(msg({ id: "m1", content: "just chatter" }), ctx);
    announceMessage(msg({ id: "m2", content: `hey @[${ME}]` }), ctx);
    settle();
    expect(notified.map((n) => n.title)).toEqual(["Them mentioned you"]);
    setRoomNotifyMode("room-a", "all");
  });

  it("marks DMs and mentions urgent, and room chatter not", () => {
    announceMessage(msg({ id: "m1", roomCode: "dm-abc" }), ctx);
    settle();
    announceMessage(msg({ id: "m2" }), ctx);
    settle();
    expect(notified.map((n) => n.urgent)).toEqual([true, false]);
  });

  it("takes down what is on the lock screen for the conversation on screen", () => {
    ctx.uiRoomCode = "room-a";
    announceMessage(msg(), ctx);
    const ref = conversationRef("room-a");
    expect(closedTags).toEqual([`dm:${ref}`, `room:${ref}`]);
  });
});

describe("room notify modes", () => {
  it("defaults to all and remembers what it is told", () => {
    expect(getRoomNotifyMode("room-z")).toBe("all");
    setRoomNotifyMode("room-z", "mentions");
    expect(getRoomNotifyMode("room-z")).toBe("mentions");
    setRoomNotifyMode("room-z", "muted");
    expect(getRoomNotifyMode("room-z")).toBe("muted");
    setRoomNotifyMode("room-z", "all");
    expect(getRoomNotifyMode("room-z")).toBe("all");
  });

  it("keeps rooms apart", () => {
    setRoomNotifyMode("room-y", "muted");
    expect(getRoomNotifyMode("room-x")).toBe("all");
    setRoomNotifyMode("room-y", "all");
  });
});
