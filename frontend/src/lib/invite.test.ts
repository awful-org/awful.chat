import { expect, it, vi } from "vitest";
import { createInvite, parseJoinInput } from "./invite";
import { newRoomSecret, deriveRoomKeys } from "./room-security/keys";
import { requireRoomSecurityRelease, ROOM_SECURITY_V2_RELEASED } from "./room-security/invitation-release";

it("accepts complete capabilities and fragment/protocol handoffs without case folding", () => {
  const secret = newRoomSecret();
  for (const input of [secret, `/r/#${secret}`, `https://chat.example/r/#${secret}`, `web+awfl://${secret}`, `/r/#${encodeURIComponent(`web+awfl://r/#${secret}`)}`]) {
    expect(parseJoinInput(input)).toEqual({ kind: "room", code: secret });
  }
});
it("accepts complete online pairing codes and folds human lookalikes", () => {
  expect(parseJoinInput("abcd-efgh jkmn-pqrs")).toEqual({ kind: "pairing", code: "ABCD-EFGH JKMN-PQRS" });
  expect(parseJoinInput("oooo-llll 2345-6789")).toEqual({ kind: "pairing", code: "0000-1111 2345-6789" });
});
it("rejects retired aliases, public IDs and malformed or path/query capabilities", () => {
  const secret = newRoomSecret();
  for (const input of ["", "7QK3M9", "a1b2c3", "6BMB3GST2JRJZ", deriveRoomKeys(secret).discoveryId, `/r/${secret}`, `/r/?secret=${secret}`, "https://example.org/", `${secret}/junk`]) {
    expect(parseJoinInput(input)).toEqual({ kind: "invalid" });
  }
});
it("retires every plaintext alias request without contacting the network", async () => {
  const fetchSpy = vi.spyOn(globalThis, "fetch");
  try {
    for (const input of ["legacy", newRoomSecret()]) await expect(createInvite(input)).rejects.toThrow("plaintext aliases are retired");
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally { fetchSpy.mockRestore(); }
});
it("honors the compiled release decision for ordinary invitations", () => {
  if (ROOM_SECURITY_V2_RELEASED) {
    expect(requireRoomSecurityRelease).not.toThrow();
  } else {
    expect(requireRoomSecurityRelease).toThrow("awaiting");
  }
});
