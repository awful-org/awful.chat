import { decryptFileTo, encryptFileTo, type EncryptedFileDescriptor } from "./file-crypto";
import { safeBlobType } from "$lib/safe-mime";

/** Staged ciphertext. The owner must release it once the transfer holds its
 * durable copy. Only ciphertext is ever staged, so decrypted bytes can never
 * be re-seeded under a protected attachment descriptor by mistake. */
export interface StagedFile {
  file: File;
  dispose(): Promise<void>;
}

async function stage(
  directory: FileSystemDirectoryHandle,
  name: string,
  mimeType: string,
  transform: (output: WritableStream<Uint8Array>) => Promise<void>,
  signal?: AbortSignal,
): Promise<StagedFile> {
  signal?.throwIfAborted();
  const entry = crypto.randomUUID();
  const handle = await directory.getFileHandle(entry, { create: true });
  let disposed = false;
  const dispose = async () => {
    if (disposed) return;
    try { await directory.removeEntry(entry); }
    catch (error) {
      if (!(error instanceof DOMException && error.name === "NotFoundError")) throw error;
    }
    disposed = true;
  };
  let writer: FileSystemWritableFileStream | undefined;
  try {
    writer = await handle.createWritable();
    const output = new WritableStream<Uint8Array>({
      async write(chunk) {
        signal?.throwIfAborted();
        await writer!.write(new Uint8Array(chunk));
      },
      async close() {
        signal?.throwIfAborted();
        await writer!.close();
      },
      async abort(reason) { await writer!.abort(reason); },
    });
    await transform(output);
    signal?.throwIfAborted();
    const snapshot = await handle.getFile();
    signal?.throwIfAborted();
    return { file: new File([snapshot], name, { type: mimeType }), dispose };
  } catch (error) {
    await writer?.abort(error).catch(() => {});
    await dispose().catch(() => {});
    throw error;
  }
}

/** Only this opaque File is suitable for torrent seeding. Its descriptor is
 * private and belongs in the authenticated conversation message. Staged in
 * `directory`, an OPFS directory the caller owns and clears (opfs-lease.ts),
 * so a large send never has to fit in memory. */
export async function stageEncryptedFile(
  source: File,
  directory: FileSystemDirectoryHandle,
  signal?: AbortSignal,
): Promise<StagedFile & {
  encryption: EncryptedFileDescriptor;
}> {
  let encryption!: EncryptedFileDescriptor;
  const staged = await stage(directory, `${crypto.randomUUID()}.bin`, "application/octet-stream", async output => {
    encryption = await encryptFileTo(source, output);
  }, signal);
  return { ...staged, file: new File([staged.file], `${encryption.id}.bin`, { type: "application/octet-stream" }), encryption };
}

/**
 * No plaintext File becomes visible until every chunk authenticates.
 *
 * Held in memory, never written to OPFS. The decrypted copy used to be staged
 * in room-v2-transfers beside the ciphertext, and only an explicit lock ever
 * removed it: closing the tab, a crash or the OS killing the PWA left every
 * picture and document opened that session on disk in the clear, outside the
 * at-rest encryption, readable at the unlock screen and untouched by the
 * duress wipe. A Blob is the browser's to keep and to release: it goes with
 * the last URL and reference to it. Memory is the cost: every decrypted file
 * stays resident while it is shown, which is why a room open decrypts only so
 * much by itself (files.svelte.ts). And a browser short of memory may still
 * page a large Blob out to its own temporary storage - Chromium does, and on
 * a phone its in-memory share is small - which it clears only when it next
 * starts, so a browser killed meanwhile leaves that copy on disk until then.
 *
 * Each authenticated chunk becomes a Blob of its own straight away, so the
 * script heap holds one chunk at a time however large the file is; the File
 * is put together from them only after the last one authenticates.
 */
export async function stageDecryptedFile(
  ciphertext: Blob,
  encryption: EncryptedFileDescriptor,
  filename: string,
  mimeType: string,
  signal?: AbortSignal,
): Promise<File> {
  signal?.throwIfAborted();
  let parts: Blob[] = [];
  await decryptFileTo(ciphertext, encryption, new WritableStream<Uint8Array>({
    write(chunk) {
      signal?.throwIfAborted();
      parts.push(new Blob([new Uint8Array(chunk)]));
    },
    close() { signal?.throwIfAborted(); },
    abort() { parts = []; },
  }));
  signal?.throwIfAborted();
  // The sender's claimed type, through the allowlist (safe-mime.ts): this
  // File becomes the blob URL every view of a downloaded file uses.
  const file = new File(parts, filename, { type: safeBlobType(mimeType) });
  parts = [];
  return file;
}
