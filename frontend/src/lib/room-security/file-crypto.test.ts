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
