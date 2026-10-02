import { describe, expect, it, vi } from "vitest";
import { DmInboxReads } from "./dm-inbox-reads";
import { MessageType, type Message } from "./types/message";

function message(roomCode: string, lamport: number): Message {
  return {
    id: `${roomCode}-${lamport}`, roomCode, senderId: "did:key:them", senderName: "Them",
    timestamp: lamport, lamport, type: MessageType.Text, content: "hi", attachments: [],
  };
}

function setup(conversations = 20) {
  const newest = new Map<string, Message>();
  const rooms = Array.from({ length: conversations }, (_, i) => {
    const roomCode = `dm-${i}`;
    newest.set(roomCode, message(roomCode, 1));
    return { roomCode, lastSeenLamport: 0 };
  });
  const lastMessage = vi.fn(async (roomCode: string) => newest.get(roomCode));
  const unreadCount = vi.fn(async (_roomCode: string, _seen: number) => 1);
  const reads = new DmInboxReads({ lastMessage, unreadCount });
  return { rooms, newest, lastMessage, unreadCount, reads };
}

describe("DmInboxReads", () => {
  it("reads each conversation once, and nothing again while nothing changes", async () => {
    const { rooms, lastMessage, unreadCount, reads } = setup();
    expect((await reads.read(rooms, () => true))?.size).toBe(20);
    expect(lastMessage).toHaveBeenCalledTimes(20);
    for (let i = 0; i < 10; i++) await reads.read(rooms, () => true);
    expect(lastMessage).toHaveBeenCalledTimes(20);
    expect(unreadCount).toHaveBeenCalledTimes(20);
  });

  it("reads again only the conversation a row was stored into", async () => {
    const { rooms, newest, lastMessage, reads } = setup();
    await reads.read(rooms, () => true);
    lastMessage.mockClear();
    newest.set("dm-3", message("dm-3", 2));
    reads.noteStored("dm-3");
    reads.noteStored("rd2_some-room");
    const out = await reads.read(rooms, () => true);
    expect(lastMessage.mock.calls.map(([room]) => room)).toEqual(["dm-3"]);
    expect(out?.get("dm-3")?.last?.lamport).toBe(2);
  });

  it("counts again a conversation whose read mark moved", async () => {
    const { rooms, unreadCount, reads } = setup();
    await reads.read(rooms, () => true);
    unreadCount.mockClear();
    unreadCount.mockResolvedValueOnce(0);
    const moved = rooms.map((r) => (r.roomCode === "dm-5" ? { ...r, lastSeenLamport: 1 } : r));
    const out = await reads.read(moved, () => true);
    expect(unreadCount.mock.calls.map(([room]) => room)).toEqual(["dm-5"]);
    expect(out?.get("dm-5")?.unread).toBe(0);
  });

  it("stops a build that a newer one replaced", async () => {
    const { rooms, lastMessage, reads } = setup();
    let alive = true;
    lastMessage.mockImplementation(async (roomCode) => {
      if (roomCode === "dm-2") alive = false;
      return message(roomCode, 1);
    });
    expect(await reads.read(rooms, () => alive)).toBeNull();
    expect(lastMessage).toHaveBeenCalledTimes(3);
    // What it did finish is kept; the rest is read by the next build.
    lastMessage.mockClear();
    await reads.read(rooms, () => true);
    expect(lastMessage).toHaveBeenCalledTimes(18);
  });

  it("re-reads a row stored while its conversation was being read", async () => {
    const { rooms, lastMessage, reads } = setup(1);
    lastMessage.mockImplementationOnce(async (roomCode) => {
      reads.noteStored(roomCode);
      return message(roomCode, 1);
    });
    await reads.read(rooms, () => true);
    await reads.read(rooms, () => true);
    expect(lastMessage).toHaveBeenCalledTimes(2);
  });

  it("does not count a conversation nobody has written in", async () => {
    const { rooms, newest, unreadCount, reads } = setup(1);
    newest.clear();
    const out = await reads.read(rooms, () => true);
    expect(out?.get("dm-0")).toEqual({ last: undefined, unread: 0 });
    expect(unreadCount).not.toHaveBeenCalled();
  });
});
