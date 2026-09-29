import { beforeEach, expect, it, vi } from "vitest";
const state = vi.hoisted(() => ({ session: { did: "alice" } as { did: string } | null }));
vi.mock("$lib/identity/identity", () => ({ requireSession: () => {
  if (!state.session) throw new Error("Locked"); return state.session;
} }));
beforeEach(() => { vi.clearAllMocks(); state.session = { did: "alice" }; });
vi.mock("$lib/storage", () => ({ getRoom: vi.fn(), putRoom: vi.fn() }));
import { getRoom, putRoom } from "$lib/storage";
import { newRoomSecret, deriveRoomKeys } from "./keys";
import { parseSecureInvitation, secureInvitationLink, storeSecureInvitation, storedRoomSecret, savedRoomInvitationLink } from "./invitations";
import { createInvite, parseJoinInput } from "$lib/invite";
import { parseRoomCode } from "$lib/palette/query";

it("keeps invitation secrets out of the URL path and query", () => {
  const secret = newRoomSecret();
  const link = secureInvitationLink("https://example.org", secret);
  expect(new URL(link).pathname).toBe("/r/");
  expect(new URL(link).search).toBe("");
  expect(parseSecureInvitation(link)).toBe(secret);
  expect(() => parseSecureInvitation(`https://example.org/r/${secret}`)).toThrow();
  expect(() => parseSecureInvitation(`https://example.org/r/?secret=${secret}`)).toThrow();
});

it("accepts the fragment-only launch form without treating a discovery ID as an invitation", () => {
  const secret = newRoomSecret();
  expect(parseRoomCode(`/r/#${secret}`)).toBe(secret);
  expect(parseRoomCode(`/r/#${deriveRoomKeys(secret).discoveryId}`)).toBeNull();
});

it("imports custom-protocol capabilities through a fragment-only browser handoff", () => {
  const secret = newRoomSecret();
  for (const protocol of [`web+awfl://${secret}`, `web+awfl://r/#${secret}`]) {
    expect(parseJoinInput(protocol)).toEqual({ kind: "room", code: secret });
    const handoff = new URL(`/r/#${encodeURIComponent(protocol)}`, "https://example.org");
    expect(handoff.pathname + handoff.search).toBe("/r/");
    expect(parseJoinInput(handoff.href)).toEqual({ kind: "room", code: secret });
    expect(parseRoomCode(handoff.pathname + decodeURIComponent(handoff.hash))).toBe(secret);
  }
  expect(parseJoinInput(`web+awfl://${deriveRoomKeys(secret).discoveryId}`)).toEqual({ kind: "invalid" });
  expect(() => parseSecureInvitation(`/r/#web%ZZ`)).toThrow();
});

it("rejects secure capabilities and identifiers before calling the legacy alias server", async () => {
  const secret = newRoomSecret();
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  try {
    await expect(createInvite(secret)).rejects.toThrow("full invitation link");
    await expect(createInvite(deriveRoomKeys(secret).discoveryId)).rejects.toThrow("full invitation link");
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});

it("imports pasted links and copies the saved secret rather than the address-bar discovery ID", async () => {
  vi.mocked(getRoom).mockResolvedValue(undefined);
  const secret = newRoomSecret();
  const room = await storeSecureInvitation(secret, "Private");
  const link = secureInvitationLink("https://example.org", secret);
  expect(parseJoinInput(link)).toEqual({ kind: "room", code: secret });
  expect(parseJoinInput(secret)).toEqual({ kind: "room", code: secret });
  expect(parseJoinInput(room.roomCode)).toEqual({ kind: "invalid" });
  vi.mocked(getRoom).mockResolvedValue(room);
  expect(await savedRoomInvitationLink("https://example.org", room.roomCode)).toBe(link);
  vi.mocked(getRoom).mockResolvedValue(undefined);
  await expect(savedRoomInvitationLink("https://example.org", room.roomCode)).rejects.toThrow("missing");
});

it("stores the secret separately from its public record key and rejects mismatches", async () => {
  vi.mocked(getRoom).mockResolvedValue(undefined);
  const secret = newRoomSecret();
  const room = await storeSecureInvitation(secret, "Private room");
  expect(room.roomCode).toBe(deriveRoomKeys(secret).discoveryId);
  expect(putRoom).toHaveBeenCalledWith(room, expect.any(Function));
  expect(storedRoomSecret(room)).toBe(secret);
  expect(() => storedRoomSecret({ ...room, roomCode: "rd2_other" })).toThrow();
});

it.each(["alice", "bob"])("does not import across a pending read and replacement unlock (%s)", async did => {
  let finish!: (value: undefined) => void;
  vi.mocked(getRoom).mockImplementationOnce(() => new Promise(r => { finish = r; }));
  const pending = storeSecureInvitation(newRoomSecret(), "Private");
  state.session = null;
  state.session = { did };
  finish(undefined);
  await expect(pending).rejects.toThrow("Identity changed");
  expect(putRoom).not.toHaveBeenCalled();
});
