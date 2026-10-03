import { expect, it } from "vitest";
import { acceptsFileDescriptors } from "./file-descriptor";
import { encryptFileTo } from "./file-crypto";

it("requires authenticated encryption descriptors on DM and room live/history files", async () => {
  const file = { infoHash: "a".repeat(40), filename: "private.txt", mimeType: "text/plain", size: 12 };
  for (const room of ["dm-local", "rd2_private"]) {
    expect(acceptsFileDescriptors(room, [file])).toBe(false);
    expect(acceptsFileDescriptors(room, undefined)).toBe(false);
    const encrypted = { ...file, encryption: await encryptFileTo(new Blob([new Uint8Array(12)]), new WritableStream({ write() {} })) };
    expect(acceptsFileDescriptors(room, [encrypted])).toBe(true);
    expect(acceptsFileDescriptors(room, [{ ...encrypted, size: 13 }])).toBe(false);
    expect(acceptsFileDescriptors(room, [{ ...encrypted, encryption: { ...encrypted.encryption, key: "bad" } }])).toBe(false);
  }
});
