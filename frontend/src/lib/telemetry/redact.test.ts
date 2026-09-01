import { describe, it, expect } from "vitest";
import { RefTable, roomKind } from "./redact";

describe("roomKind", () => {
  it("classifies a DM room by its documented prefix", () => {
    expect(roomKind("dm-" + "a".repeat(40))).toBe("dm");
  });

  it("classifies the device-sync pseudo-room", () => {
    expect(roomKind("__sync_deadbeefdeadbeef")).toBe("sync");
  });

  it("classifies an 8-byte hex code as text", () => {
    expect(roomKind("0123456789abcdef")).toBe("text");
  });

  it("classifies a legacy 3-byte code as text", () => {
    expect(roomKind("a1b2c3")).toBe("text");
  });
});

describe("RefTable", () => {
  it("assigns ordinals in first-seen order and is stable", () => {
    const refs = new RefTable(() => 1000);
    expect(refs.roomRef("aaaaaaaaaaaaaaaa")).toBe("r1");
    expect(refs.roomRef("bbbbbbbbbbbbbbbb")).toBe("r2");
    expect(refs.roomRef("aaaaaaaaaaaaaaaa")).toBe("r1");
  });

  it("assigns identity and file ordinals in their own namespaces", () => {
    const refs = new RefTable(() => 0);
    expect(refs.identityRef("did:key:zAAA")).toBe("i1");
    expect(refs.identityRef("did:key:zBBB")).toBe("i2");
    expect(refs.identityRef("did:key:zAAA")).toBe("i1");
    expect(refs.fileRef("hash-a")).toBe("f1");
    expect(refs.fileRef("hash-a")).toBe("f1");
    expect(refs.fileRef("hash-b")).toBe("f2");
  });

  it("records the join time from the injected clock", () => {
    let now = 5000;
    const refs = new RefTable(() => now);
    refs.roomRef("aaaaaaaaaaaaaaaa");
    now = 9000;
    refs.roomRef("dm-" + "b".repeat(40));
    expect(refs.rooms()).toEqual([
      { ref: "r1", kind: "text", joinedAt: 5000 },
      { ref: "r2", kind: "dm", joinedAt: 9000 },
    ]);
  });

  it("keeps codes out of the serializable room list", () => {
    const refs = new RefTable(() => 0);
    const code = "0123456789abcdef";
    refs.roomRef(code);
    expect(JSON.stringify(refs.rooms())).not.toContain(code);
    // The code is reachable ONLY through knownRooms, which is never serialized.
    expect(refs.knownRooms()[0].code).toBe(code);
  });

  it("never correlates across two tables", () => {
    // A new session gets a new table, so "r1" in two bundles means nothing.
    const a = new RefTable(() => 0);
    const b = new RefTable(() => 0);
    a.roomRef("first");
    b.roomRef("second");
    expect(a.knownRooms()[0].ref).toBe(b.knownRooms()[0].ref);
    expect(a.knownRooms()[0].code).not.toBe(b.knownRooms()[0].code);
  });
});
