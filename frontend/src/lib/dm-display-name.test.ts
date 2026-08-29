import { describe, expect, it } from "vitest";
import { resolveDmRoomDisplayName } from "./dm-display-name";
import type { DMRoom, PhonebookEntry, Room } from "./storage";

const DM = "dm-4a1619b2ab58410f1535359aa537b5786812bd45";
const DID = "did:key:zBob";

const dmRoom = (participantDid?: string): DMRoom =>
  ({
    roomCode: DM,
    type: "dm",
    name: "",
    lastSeenLamport: 0,
    createdAt: 1,
    participants: [],
    ...(participantDid ? { participantDid } : {}),
  }) as DMRoom;

const phone = (e: Partial<PhonebookEntry>): PhonebookEntry =>
  ({ peerId: "12D3KooWBob", nickname: "", addedAt: 1, ...e }) as PhonebookEntry;

describe("resolveDmRoomDisplayName", () => {
  it("leaves a non-DM room code alone", () => {
    expect(resolveDmRoomDisplayName("general", [], [], new Map())).toBe(
      "general"
    );
  });

  // The live map is the first source the app's own resolver checks.
  it("prefers the live peer name", () => {
    const names = new Map([[DID, "Bob"]]);
    expect(
      resolveDmRoomDisplayName(DM, [dmRoom(DID)], [phone({ did: DID, nickname: "Old Bob" })], names)
    ).toBe("Bob");
  });

  // The phonebook nickname survives a reload with no cached profile, which is
  // the case a DM from a stranger hits.
  it("falls back to the phonebook nickname", () => {
    expect(
      resolveDmRoomDisplayName(DM, [dmRoom(DID)], [phone({ did: DID, nickname: "Bob" })], new Map())
    ).toBe("Bob");
  });

  it("matches a phonebook entry filed under peerId rather than did", () => {
    expect(
      resolveDmRoomDisplayName(DM, [dmRoom(DID)], [phone({ peerId: DID, nickname: "Bob" })], new Map())
    ).toBe("Bob");
  });

  // The room can be in either list depending on how it was created. Searching
  // only dmRooms is what made this return a truncated code.
  it("finds the room whichever list it was filed under", () => {
    const plain = dmRoom(DID) as unknown as Room;
    expect(
      resolveDmRoomDisplayName(DM, [plain], [phone({ did: DID, nickname: "Bob" })], new Map())
    ).toBe("Bob");
  });

  it("truncates when the room is not found at all", () => {
    expect(resolveDmRoomDisplayName(DM, [], [], new Map())).toBe("dm-4a1619b2a");
  });

  it("truncates when the room carries no counterparty did", () => {
    expect(
      resolveDmRoomDisplayName(DM, [dmRoom()], [phone({ did: DID, nickname: "Bob" })], new Map())
    ).toBe("dm-4a1619b2a");
  });

  it("truncates when nothing knows the name", () => {
    expect(
      resolveDmRoomDisplayName(DM, [dmRoom(DID)], [], new Map())
    ).toBe("dm-4a1619b2a");
  });
});
