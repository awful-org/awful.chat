import { describe, expect, it } from "vitest";
import { reconcileRoomUsers } from "./room-roster";

const PEER = "12D3KooWabc";
const DID = "did:key:z6Mkabc";

describe("reconcileRoomUsers", () => {
  it("replaces a raw-peerId placeholder with the proven DID", () => {
    const result = reconcileRoomUsers(["did:key:other", PEER], PEER, DID);
    expect(result).toEqual(["did:key:other", DID]);
  });

  it("does not duplicate the DID if it is already present", () => {
    const result = reconcileRoomUsers([DID, PEER], PEER, DID);
    expect(result).toEqual([DID]);
  });

  it("returns the SAME array instance when there is no placeholder to fold", () => {
    const roster = ["did:key:other"];
    expect(reconcileRoomUsers(roster, PEER, DID)).toBe(roster);
  });

  it("is a no-op when the peerId and DID are already the same string", () => {
    // Guards a caller that got confused about which one it has - never
    // deletes and re-adds the identical entry.
    const roster = [PEER];
    expect(reconcileRoomUsers(roster, PEER, PEER)).toBe(roster);
  });

  it("is a no-op when the peerId was never admitted", () => {
    const roster = ["did:key:other"];
    expect(reconcileRoomUsers(roster, "12D3KooWnever-joined", DID)).toBe(
      roster
    );
  });
});
