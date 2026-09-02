import { beforeEach, describe, expect, it } from "vitest";
import {
  drainNotifyIntents,
  rememberRoomRef,
  storeNotifyIntent,
  ROOM_REF_PREFIX,
  type NotifyIntent,
} from "./notify-intents";

// fake-indexeddb (from test-setup) backs the raw "awful-notify" DB the
// service worker writes and the app drains.

function intent(overrides: Partial<NotifyIntent> = {}): NotifyIntent {
  return {
    kind: "reply",
    roomCode: "room-1",
    text: "hello",
    ts: Date.now(),
    ...overrides,
  };
}

beforeEach(async () => {
  // Drain whatever a previous test left behind: the store must start empty.
  await drainNotifyIntents();
});

describe("notify intents", () => {
  it("drains stored intents oldest first and clears the store", async () => {
    await storeNotifyIntent(intent({ text: "first" }));
    await storeNotifyIntent(intent({ text: "second", kind: "open" }));

    const drained = await drainNotifyIntents();
    expect(drained.map((i) => i.text)).toEqual(["first", "second"]);
    expect(drained[1].kind).toBe("open");

    expect(await drainNotifyIntents()).toEqual([]);
  });

  it("keeps DM addressing intact", async () => {
    await storeNotifyIntent(
      intent({ dmPeerDid: "did:key:zPeer", roomCode: "dm-x" })
    );
    const [got] = await drainNotifyIntents();
    expect(got.dmPeerDid).toBe("did:key:zPeer");
    expect(got.roomCode).toBe("dm-x");
  });

  it("turns a conversation ref back into the room code it stands for", async () => {
    const ref = `${ROOM_REF_PREFIX}0123456789abcdef`;
    await rememberRoomRef(ref, "the-real-room-code");
    await storeNotifyIntent(intent({ roomCode: ref, text: "reply" }));

    const [got] = await drainNotifyIntents();
    expect(got.roomCode).toBe("the-real-room-code");
    expect(got.text).toBe("reply");
  });

  it("drops an intent whose ref this device cannot resolve", async () => {
    // The mapping is gone (a wipe, cleared site data). Routing the reply to
    // the ref itself would send it to a conversation nobody named.
    await storeNotifyIntent(
      intent({ roomCode: `${ROOM_REF_PREFIX}deadbeefdeadbeef` })
    );
    expect(await drainNotifyIntents()).toEqual([]);
  });

  it("still routes an intent from a build that stored the room code itself", async () => {
    await storeNotifyIntent(intent({ roomCode: "plain-room" }));
    const [got] = await drainNotifyIntents();
    expect(got.roomCode).toBe("plain-room");
  });

  it("drops intents older than 24h but still clears them", async () => {
    await storeNotifyIntent(intent({ ts: Date.now() - 25 * 60 * 60 * 1000 }));
    await storeNotifyIntent(intent({ text: "fresh" }));

    const drained = await drainNotifyIntents();
    expect(drained.map((i) => i.text)).toEqual(["fresh"]);
    // The stale one was cleared, not left to reappear.
    expect(await drainNotifyIntents()).toEqual([]);
  });
});
