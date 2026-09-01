import { beforeEach, describe, expect, it } from "vitest";
import { getRoom, deleteRoom, putRoom, type Room } from "./storage";
import { renameRoom, roomsStore, saveRoom, removeRoom } from "./rooms.svelte";
import { identityStore } from "./identity/identity.svelte";

const ROOM = "room-name-spec";

function room(patch: Partial<Room> = {}): Room {
  return {
    roomCode: ROOM,
    type: "text",
    name: "Old Name",
    lastSeenLamport: 0,
    createdAt: 1,
    participants: [],
    participantLastSeen: {},
    ...patch,
  };
}

describe("renameRoom", () => {
  beforeEach(async () => {
    await deleteRoom(ROOM);
    roomsStore.rooms = [];
  });

  it("writes the record and the mirror", async () => {
    await putRoom(room());
    roomsStore.rooms = [room()];

    await renameRoom(ROOM, "New Name");

    expect((await getRoom(ROOM))?.name).toBe("New Name");
    expect(roomsStore.rooms[0].name).toBe("New Name");
  });

  it("trims and caps at 64 characters", async () => {
    await putRoom(room());
    roomsStore.rooms = [room()];

    await renameRoom(ROOM, "  " + "x".repeat(80) + "  ");

    expect((await getRoom(ROOM))?.name).toBe("x".repeat(64));
  });

  // A peer that joined from a bare invite link has no name and sends the room
  // code as a placeholder. Accepting it blanks the real name for everyone.
  it("refuses an empty name and the room code as a name", async () => {
    await putRoom(room());
    roomsStore.rooms = [room()];

    await renameRoom(ROOM, "   ");
    await renameRoom(ROOM, ROOM);

    expect((await getRoom(ROOM))?.name).toBe("Old Name");
  });

  // The bug this pins: a peer answers our join announcement with the room's
  // name the instant it sees it, which routinely beats our own saveRoom. The
  // name used to be dropped for good - the header read it from transportState
  // and looked right, while the sidebar and every later reload showed the code.
  it("replays a name that arrived before the room existed", async () => {
    await renameRoom(ROOM, "Retro Notes");
    expect(await getRoom(ROOM)).toBeUndefined();

    // saveRoom is called with the placeholder label an invite-link join has.
    await saveRoom(ROOM, ROOM);

    expect((await getRoom(ROOM))?.name).toBe("Retro Notes");
    expect(roomsStore.rooms[0].name).toBe("Retro Notes");
  });

  it("replays it only once", async () => {
    await renameRoom(ROOM, "Retro Notes");
    await saveRoom(ROOM, ROOM);
    await renameRoom(ROOM, "Renamed By Me");

    await saveRoom(ROOM, ROOM);

    expect((await getRoom(ROOM))?.name).toBe("Renamed By Me");
  });

  it("forgets a held name when the room is removed", async () => {
    await renameRoom(ROOM, "Retro Notes");
    await removeRoom(ROOM);

    await saveRoom(ROOM, ROOM);

    expect((await getRoom(ROOM))?.name).toBe(ROOM);
  });

  it("keeps participants and the read watermark that moved since page load", async () => {
    roomsStore.rooms = [room()];
    await putRoom(room({ lastSeenLamport: 42, participants: ["did:key:them"] }));

    await renameRoom(ROOM, "New Name");

    const stored = await getRoom(ROOM);
    expect(stored?.lastSeenLamport).toBe(42);
    expect(stored?.participants).toEqual(["did:key:them"]);
    expect(stored?.name).toBe("New Name");
  });
});

// joinRoom's own addRoomParticipant(self) runs BEFORE this record exists -
// AppView creates it only once the join resolves - and _patchRoom is a no-op on
// a missing row. So on a first join our own membership was never written down,
// and only a second join repaired it.
describe("saveRoom membership", () => {
  const SELF = "did:key:z6MkSelfTestOnly";

  beforeEach(async () => {
    await deleteRoom(ROOM);
    roomsStore.rooms = [];
  });

  it("seeds this identity as a participant on a first join", async () => {
    const previous = identityStore.did;
    identityStore.did = SELF;
    try {
      await saveRoom(ROOM, "Design Review");
    } finally {
      identityStore.did = previous;
    }

    const stored = await getRoom(ROOM);
    expect(stored?.participants).toEqual([SELF]);
    expect(stored?.participantLastSeen?.[SELF]).toBeTypeOf("number");
  });

  it("creates an empty member list while the identity is locked", async () => {
    const previous = identityStore.did;
    identityStore.did = null;
    try {
      await saveRoom(ROOM, "Design Review");
    } finally {
      identityStore.did = previous;
    }

    expect((await getRoom(ROOM))?.participants).toEqual([]);
  });

  // saveRoom is called on EVERY join, and the existing record is authoritative:
  // rebuilding it would roll back the watermark and the member list.
  it("leaves an existing record alone", async () => {
    await putRoom(room({ lastSeenLamport: 9, participants: ["did:key:them"] }));
    const previous = identityStore.did;
    identityStore.did = SELF;
    try {
      await saveRoom(ROOM, "Ignored");
    } finally {
      identityStore.did = previous;
    }

    const stored = await getRoom(ROOM);
    expect(stored?.name).toBe("Old Name");
    expect(stored?.lastSeenLamport).toBe(9);
    expect(stored?.participants).toEqual(["did:key:them"]);
  });
});