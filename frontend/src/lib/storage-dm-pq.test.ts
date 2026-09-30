import { afterEach, beforeEach, expect, it } from "vitest";
import { getRoom, putRoom, setDmPqState, wipeLocalDatabase, type DMRoom } from "./storage";
import { clearStorageCrypto, initStorageCrypto } from "./storage-crypto";
import type { DmPqState } from "./room-security/pq-dm";

beforeEach(async () => {
  await initStorageCrypto(new Uint8Array(32).fill(7));
  await wipeLocalDatabase();
});
afterEach(() => clearStorageCrypto());

const code = "dm-" + "c".repeat(40);
const dm: DMRoom = {
  roomCode: code, type: "dm", name: "", lastSeenLamport: 0, createdAt: 1,
  participants: ["did:key:zPeer"], participantDid: "did:key:zPeer",
};
const state = (n: string): DmPqState => ({ v: 1, ct: n.repeat(4), ek: n.repeat(8) });

it("records a DM's post-quantum state, replaces it, and reports no-ops", async () => {
  await putRoom(dm);
  expect(await setDmPqState(code, state("a"))).toBe(true);
  expect(((await getRoom(code)) as DMRoom).pq).toEqual(state("a"));
  expect(await setDmPqState(code, state("a"))).toBe(false);
  expect(await setDmPqState(code, state("b"))).toBe(true);
  expect(((await getRoom(code)) as DMRoom).pq).toEqual(state("b"));
  expect(await setDmPqState("dm-" + "d".repeat(40), state("a"))).toBe(false);
});

it("never loses the state to a writer holding an older copy of the room", async () => {
  await putRoom(dm);
  const stale = (await getRoom(code)) as DMRoom; // read before the upgrade...
  await setDmPqState(code, state("a"));
  await putRoom({ ...stale, name: "renamed" }); // ...written after it
  const now = (await getRoom(code)) as DMRoom;
  expect(now.name).toBe("renamed");
  expect(now.pq).toEqual(state("a"));
});

it("does not touch rooms that are not DMs", async () => {
  await putRoom({ roomCode: "room-x", type: "text", name: "x", lastSeenLamport: 0, createdAt: 1, participants: [] });
  expect(await setDmPqState("room-x", state("a"))).toBe(false);
  expect((await getRoom("room-x")) as DMRoom).not.toHaveProperty("pq");
});
