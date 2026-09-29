import { decryptFileTo, encryptFileTo, type EncryptedFileDescriptor } from "./file-crypto";

/** The owner must release the staged file after the transfer/preview closes.
 * Keeping ciphertext and plaintext staging distinct avoids accidentally
 * re-seeding decrypted bytes under a protected attachment descriptor. */
export interface StagedFile {
  file: File;
  dispose(): Promise<void>;
}

async function stage(
  name: string,
  mimeType: string,
  transform: (output: WritableStream<Uint8Array>) => Promise<void>,
  signal?: AbortSignal,
): Promise<StagedFile> {
  signal?.throwIfAborted();
  if (!navigator.storage?.getDirectory) {
    throw new Error("Encrypted file transfers need browser storage support. Please update your browser.");
  }
  const root = await navigator.storage.getDirectory();
  const directory = await root.getDirectoryHandle("room-v2-transfers", { create: true });
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
 * private and belongs in the authenticated conversation message. */
export async function stageEncryptedFile(source: File, signal?: AbortSignal): Promise<StagedFile & {
  encryption: EncryptedFileDescriptor;
}> {
  let encryption!: EncryptedFileDescriptor;
  const staged = await stage(`${crypto.randomUUID()}.bin`, "application/octet-stream", async output => {
    encryption = await encryptFileTo(source, output);
  }, signal);
  return { ...staged, file: new File([staged.file], `${encryption.id}.bin`, { type: "application/octet-stream" }), encryption };
}

/** No plaintext File becomes visible until every chunk authenticates. */
export function stageDecryptedFile(
  ciphertext: Blob,
  encryption: EncryptedFileDescriptor,
  filename: string,
  mimeType: string,
  signal?: AbortSignal,
): Promise<StagedFile> {
  return stage(filename, mimeType, output => decryptFileTo(ciphertext, encryption, output), signal);
}
