/** Durable opaque ciphertext. No keys, names or MIME types enter OPFS paths. */
async function directory() {
  if (!globalThis.navigator?.storage?.getDirectory) throw new Error("Encrypted files require browser storage support");
  return (await navigator.storage.getDirectory()).getDirectoryHandle("room-v2-ciphertext", { create: true });
}
function check(hash: string) {
  if (!/^[a-f0-9]{40}$/i.test(hash)) throw new Error("Invalid ciphertext reference");
}
export async function readCiphertext(hash: string): Promise<File | null> {
  check(hash);
  try { return await (await (await directory()).getFileHandle(hash)).getFile(); }
  catch (e) { if (e instanceof DOMException && e.name === "NotFoundError") return null; throw e; }
}
export async function writeCiphertext(hash: string, source: Blob | AsyncIterable<Uint8Array>, signal?: AbortSignal): Promise<File> {
  check(hash);
  signal?.throwIfAborted();
  const dir = await directory();
  const handle = await dir.getFileHandle(hash, { create: true });
  const writer = await handle.createWritable();
  try {
    if (source instanceof Blob) {
      for (let offset = 0; offset < source.size; offset += 1024 * 1024) {
        signal?.throwIfAborted();
        await writer.write(source.slice(offset, offset + 1024 * 1024));
      }
    } else {
      for await (const chunk of source) {
        signal?.throwIfAborted();
        await writer.write(new Uint8Array(chunk));
      }
    }
    signal?.throwIfAborted();
    await writer.close();
    return await handle.getFile();
  } catch (e) {
    await writer.abort().catch(() => {});
    await dir.removeEntry(hash).catch(() => {});
    throw e;
  }
}
export async function removeCiphertext(hash: string): Promise<void> {
  check(hash);
  await (await directory()).removeEntry(hash).catch(e => {
    if (!(e instanceof DOMException && e.name === "NotFoundError")) throw e;
  });
}
export async function wipeCiphertext(): Promise<void> {
  if (!globalThis.navigator?.storage?.getDirectory) return;
  const root = await navigator.storage.getDirectory();
  for (const name of ["room-v2-ciphertext", "room-v2-transfers", "room-v2-pieces"]) {
    await root.removeEntry(name, { recursive: true }).catch(e => {
      if (!(e instanceof DOMException && e.name === "NotFoundError")) throw e;
    });
  }
}
