import { expect, it, vi } from "vitest";
import { encryptFileTo, decryptFileTo } from "./file-crypto";

function sink() {
  const chunks: Uint8Array<ArrayBuffer>[] = [];
  const abort = vi.fn(() => { chunks.length = 0; });
  return { chunks, abort, stream: new WritableStream<Uint8Array>({ write(chunk) { chunks.push(new Uint8Array(chunk)); }, abort }) };
}

it.each([0, 11, 1024 * 1024 + 19])("round-trips %i file bytes with bounded authenticated chunks", async (size) => {
  const source = new Uint8Array(size).fill(42);
  const encrypted = sink();
  const descriptor = await encryptFileTo(new Blob([source]), encrypted.stream);
  const target = sink();
  await decryptFileTo(new Blob(encrypted.chunks), descriptor, target.stream);
  const restored = new Uint8Array(await new Blob(target.chunks).arrayBuffer());
  expect(restored.length).toBe(source.length);
  expect(restored.every((byte, index) => byte === source[index])).toBe(true);
});

it("reports plaintext bytes encrypted after each completed chunk", async () => {
  const encrypted = sink();
  const progress: number[] = [];
  await encryptFileTo(
    new Blob([new Uint8Array(1024 * 1024 + 20)]),
    encrypted.stream,
    (bytes) => progress.push(bytes),
  );
  expect(progress).toEqual([0, 1024 * 1024, 1024 * 1024 + 20]);
});

it("rejects a substituted last chunk and aborts already-written partial plaintext", async () => {
  const encrypted = sink();
  const descriptor = await encryptFileTo(new Blob([new Uint8Array(1024 * 1024 + 20)]), encrypted.stream);
  encrypted.chunks[1][0] ^= 1;
  const target = sink();
  await expect(decryptFileTo(new Blob(encrypted.chunks), descriptor, target.stream)).rejects.toThrow();
  expect(target.abort).toHaveBeenCalledOnce();
  expect(target.chunks).toHaveLength(0);
});

it("rejects truncation before publishing output", async () => {
  const encrypted = sink();
  const descriptor = await encryptFileTo(new Blob(["secret"]), encrypted.stream);
  const target = sink();
  await expect(decryptFileTo(new Blob(encrypted.chunks).slice(1), descriptor, target.stream)).rejects.toThrow("length");
  expect(target.chunks).toHaveLength(0);
});

it.each([0, 19, 1024 * 1024 + 19])("decrypts %i bytes from arbitrarily fragmented ciphertext", async size => {
  const encrypted = sink();
  const descriptor = await encryptFileTo(new Blob([new Uint8Array(size).fill(42)]), encrypted.stream);
  const bytes = new Uint8Array(await new Blob(encrypted.chunks).arrayBuffer());
  async function* fragmented() {
    yield new Uint8Array();
    for (let offset = 0; offset < bytes.length; offset += 65537) yield bytes.subarray(offset, offset + 65537);
  }
  const target = sink();
  await decryptFileTo(fragmented(), descriptor, target.stream);
  expect(await new Blob(target.chunks).arrayBuffer()).toEqual(new Uint8Array(size).fill(42).buffer);
});

it.each(["truncated", "extra", "corrupt"])("aborts partial stream output on %s ciphertext and closes the source", async mode => {
  const encrypted = sink();
  const descriptor = await encryptFileTo(new Blob([new Uint8Array(1024 * 1024 + 19)]), encrypted.stream);
  const closed = vi.fn();
  async function* source() {
    try {
      yield encrypted.chunks[0];
      const last = encrypted.chunks[1].slice();
      if (mode === "corrupt") last[0] ^= 1;
      yield mode === "truncated" ? last.subarray(0, last.length - 1) : last;
      if (mode === "extra") yield new Uint8Array([1]);
    } finally { closed(); }
  }
  const target = sink();
  await expect(decryptFileTo(source(), descriptor, target.stream)).rejects.toThrow();
  expect(target.chunks).toHaveLength(0);
  expect(target.abort).toHaveBeenCalledOnce();
  expect(closed).toHaveBeenCalledOnce();
});
