import { beforeEach, describe, expect, it } from "vitest";
import { getRoom, putRoom, deleteRoom, type Room } from "./storage";
import { roomsStore, saveRoom, setRoomIcon, removeRoom } from "./rooms.svelte";

const ROOM = "room-icon-spec";
const GIF = "https://gifs.test/party.gif";
const PNG = "data:image/png;base64,iVBORw0KGgo=";

function room(patch: Partial<Room> = {}): Room {
  return {
    roomCode: ROOM,
    type: "text",
    name: "Room",
    lastSeenLamport: 0,
    createdAt: 1,
    participants: [],
    participantLastSeen: {},
    ...patch,
  };
}

/** Put the record and the mirror in the state a joined room is normally in. */
async function seed(patch: Partial<Room> = {}): Promise<void> {
  await putRoom(room(patch));
  roomsStore.rooms = [room(patch)];
}

describe("setRoomIcon", () => {
  beforeEach(async () => {
    await deleteRoom(ROOM);
    roomsStore.rooms = [];
  });

  it("stores an emoji in both the record and the mirror", async () => {
    await seed();

    await setRoomIcon(ROOM, { emoji: "🎉" });

    expect((await getRoom(ROOM))?.emoji).toBe("🎉");
    expect(roomsStore.rooms[0].emoji).toBe("🎉");
  });

  it("stores an image url", async () => {
    await seed();

    await setRoomIcon(ROOM, { url: GIF });

    expect((await getRoom(ROOM))?.pfpURL).toBe(GIF);
    expect(roomsStore.rooms[0].pfpURL).toBe(GIF);
  });

  // A room wears one icon. Leaving the old form behind left an emoji rendering
  // underneath a freshly picked GIF at every call site that checks emoji first.
  it("clears the emoji when an image is set, and the other way round", async () => {
    await seed({ emoji: "🎉" });

    await setRoomIcon(ROOM, { url: PNG });
    expect((await getRoom(ROOM))?.emoji).toBeUndefined();
    expect((await getRoom(ROOM))?.pfpURL).toBe(PNG);

    await setRoomIcon(ROOM, { emoji: "☕" });
    expect((await getRoom(ROOM))?.pfpURL).toBeUndefined();
    expect((await getRoom(ROOM))?.emoji).toBe("☕");
  });

  it("a url wins when a caller supplies both", async () => {
    await seed();

    await setRoomIcon(ROOM, { emoji: "🎉", url: GIF });

    expect((await getRoom(ROOM))?.pfpURL).toBe(GIF);
    expect((await getRoom(ROOM))?.emoji).toBeUndefined();
  });

  it("null clears both forms", async () => {
    await seed({ emoji: "🎉" });

    await setRoomIcon(ROOM, null);

    const stored = await getRoom(ROOM);
    expect(stored?.emoji).toBeUndefined();
    expect(stored?.pfpURL).toBeUndefined();
  });

  // Values reach here straight off the wire, where any peer in the room can
  // write them. Junk has to read as "no icon" rather than land in the slot.
  it("refuses text, markup and hostile urls", async () => {
    await seed({ emoji: "🎉" });

    for (const bad of ["room name", "<script>", "AB", "😀😀"]) {
      await setRoomIcon(ROOM, { emoji: bad });
      expect((await getRoom(ROOM))?.emoji).toBeUndefined();
    }

    for (const bad of ["javascript:alert(1)", "data:text/html,<script>"]) {
      await setRoomIcon(ROOM, { url: bad });
      expect((await getRoom(ROOM))?.pfpURL).toBeUndefined();
    }
  });

  // renameRoom patches the stored record for this exact reason: the mirror is
  // refreshed rarely, so writing a whole room back from it rolls participants
  // and the read watermark back to whatever they were at page load.
  it("keeps participants and the read watermark that moved since page load", async () => {
    roomsStore.rooms = [room()];
    await putRoom(
      room({ lastSeenLamport: 42, participants: ["did:key:them"] })
    );

    await setRoomIcon(ROOM, { emoji: "🎉" });

    const stored = await getRoom(ROOM);
    expect(stored?.lastSeenLamport).toBe(42);
    expect(stored?.participants).toEqual(["did:key:them"]);
    expect(stored?.emoji).toBe("🎉");
  });

  it("creates no record for a room this device does not have", async () => {
    await setRoomIcon("room-never-joined", { emoji: "🎉" });

    expect(await getRoom("room-never-joined")).toBeUndefined();
  });

  // A peer answers our join announcement with the room's icon the instant it
  // sees it, which routinely beats our own saveRoom. Dropping the icon there
  // left the room bare until something happened to resend.
  it("replays an icon that arrived before the room existed", async () => {
    await setRoomIcon(ROOM, { emoji: "🎉" });
    expect(await getRoom(ROOM)).toBeUndefined();

    await saveRoom(ROOM, "Room");

    expect((await getRoom(ROOM))?.emoji).toBe("🎉");
    expect(roomsStore.rooms[0].emoji).toBe("🎉");
  });

  it("replays it only once", async () => {
    await setRoomIcon(ROOM, { emoji: "🎉" });
    await saveRoom(ROOM, "Room");
    await setRoomIcon(ROOM, null);

    // A second join must not resurrect the icon the user just removed.
    await saveRoom(ROOM, "Room");

    expect((await getRoom(ROOM))?.emoji).toBeUndefined();
  });

  it("forgets a held icon when the room is removed", async () => {
    await setRoomIcon(ROOM, { emoji: "🎉" });
    await removeRoom(ROOM);

    await saveRoom(ROOM, "Room");

    expect((await getRoom(ROOM))?.emoji).toBeUndefined();
  });

  it("holds nothing for junk that failed sanitizing", async () => {
    await setRoomIcon(ROOM, { emoji: "PWNED" });

    await saveRoom(ROOM, "Room");

    expect((await getRoom(ROOM))?.emoji).toBeUndefined();
  });

  // The old byte form is never written for a room, but a record restored from
  // an older backup can carry one, and it would outrank the new icon.
  it("drops a legacy pfpData blob when an icon is set", async () => {
    const bytes = new Uint8Array([1, 2, 3]).buffer;
    await seed({ pfpData: bytes });

    await setRoomIcon(ROOM, { emoji: "🎉" });

    expect((await getRoom(ROOM))?.pfpData).toBeUndefined();
  });
});
