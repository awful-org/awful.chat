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
it("accepts a capability in any case and hands back the lowercase form", () => {
  const secret = newRoomSecret();
  expect(secret).toBe(secret.toLowerCase());
  for (const input of [secret.toUpperCase(), `https://chat.example/r/#${secret.toUpperCase()}`]) {
    expect(parseJoinInput(input)).toEqual({ kind: "room", code: secret });
  }
});
it("accepts six-character online pairing codes, lowercase, folding human lookalikes", () => {
  expect(parseJoinInput("k5t-8r5")).toEqual({ kind: "pairing", code: "k5t-8r5" });
  expect(parseJoinInput(" K5T 8R5 ")).toEqual({ kind: "pairing", code: "k5t-8r5" });
  expect(parseJoinInput("k5t8r5")).toEqual({ kind: "pairing", code: "k5t-8r5" });
  expect(parseJoinInput("ooo-lll")).toEqual({ kind: "pairing", code: "000-111" });
  for (const wrong of ["k5t-8r", "k5t-8r5a", "k5u-8r5"]) {
    expect(parseJoinInput(wrong)).toEqual({ kind: "invalid" });
  }
});
it("accepts a short link, in the fragment only", () => {
  for (const input of ["https://awful.chat/r/#k5t-8r5", "awful.chat/r/#K5T8R5", "/r/#k5t-8r5", " http://127.0.0.1:5173/r/#k5t-8r5 "]) {
    expect(parseJoinInput(input)).toEqual({ kind: "pairing", code: "k5t-8r5" });
  }
  for (const input of ["https://awful.chat/r/k5t-8r5", "https://awful.chat/r/#k5t-8r5/x", "https://awful.chat/r/?c=k5t-8r5", "https://awful.chat/#k5t-8r5"]) {
    expect(parseJoinInput(input)).toEqual({ kind: "invalid" });
  }
});
it("rejects public IDs, old room codes and malformed or path/query capabilities", () => {
  const secret = newRoomSecret();
  // Six-character inputs are pairing-code shaped now; a retired short alias
  // such as "7QK3M9" is tried as a pairing and fails at the relay - never
  // looked up as a plaintext alias, which is what this guards.
  for (const input of ["", "6BMB3GST2JRJZ", deriveRoomKeys(secret).discoveryId, `/r/${secret}`, `/r/?secret=${secret}`, "https://example.org/", `${secret}/junk`]) {
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
