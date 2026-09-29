import { base64urlnopad as b64 } from "@scure/base";

const CHUNK = 1024 * 1024;
const MAX_SIZE = 1024 ** 4;
const te = new TextEncoder();

/** This descriptor contains the decryption key. Deliver it ONLY inside the
 * authenticated room envelope, never in torrent metadata or public signals. */
export interface EncryptedFileDescriptor {
  version: 2;
  key: string;
  id: string;
  size: number;
  chunkSize: number;
}

export function validateFileEncryption(d: EncryptedFileDescriptor): void {
  if (!d || typeof d !== "object") throw new Error("Invalid encrypted file descriptor");
  if (d.version !== 2 || d.chunkSize !== CHUNK || !Number.isSafeInteger(d.size) ||
      d.size < 0 || d.size > MAX_SIZE || !/^[A-Za-z0-9_-]{43}$/.test(d.key) ||
      !/^[A-Za-z0-9_-]{22}$/.test(d.id) || b64.encode(b64.decode(d.key)) !== d.key ||
      b64.encode(b64.decode(d.id)) !== d.id) throw new Error("Invalid encrypted file descriptor");
}

function parameters(d: EncryptedFileDescriptor, index: number): AesGcmParams {
  const iv = new Uint8Array(12);
  new DataView(iv.buffer).setUint32(8, index);
  return {
    name: "AES-GCM", iv, tagLength: 128,
    additionalData: te.encode(JSON.stringify(["awful:file:v2", d.id, d.size, d.chunkSize, index])),
  };
}

/** Consumes bounded Blob slices and streams ciphertext to the supplied sink.
 * A fresh random key is generated for EVERY encryption, including re-uploads.
 * The output is opaque bytes; filenames and MIME types belong in the protected
 * room message, not the torrent name. The sink must discard on abort. */
export async function encryptFileTo(file: Blob, output: WritableStream<Uint8Array>): Promise<EncryptedFileDescriptor> {
  const descriptor: EncryptedFileDescriptor = {
    version: 2, key: b64.encode(crypto.getRandomValues(new Uint8Array(32))),
    id: b64.encode(crypto.getRandomValues(new Uint8Array(16))), size: file.size, chunkSize: CHUNK,
  };
  validateFileEncryption(descriptor);
  const key = await crypto.subtle.importKey("raw", new Uint8Array(b64.decode(descriptor.key)), "AES-GCM", false, ["encrypt"]);
  const writer = output.getWriter();
  try {
    const count = Math.max(1, Math.ceil(file.size / CHUNK));
    for (let index = 0; index < count; index++) {
      const chunk = await file.slice(index * CHUNK, (index + 1) * CHUNK).arrayBuffer();
      await writer.write(new Uint8Array(await crypto.subtle.encrypt(parameters(descriptor, index), key, chunk)));
    }
    await writer.close();
    return descriptor;
  } catch (error) { await writer.abort(error).catch(() => {}); throw error; }
  finally { writer.releaseLock(); }
}

/** Every chunk is authenticated before writing. Consumers must not publish
 * partial output; abort discards it if any later chunk fails authentication. */
export async function decryptFileTo(file: Blob, descriptor: EncryptedFileDescriptor, output: WritableStream<Uint8Array>): Promise<void> {
  validateFileEncryption(descriptor);
  const count = Math.max(1, Math.ceil(descriptor.size / CHUNK));
  if (file.size !== descriptor.size + count * 16) throw new Error("Encrypted file length mismatch");
  const key = await crypto.subtle.importKey("raw", new Uint8Array(b64.decode(descriptor.key)), "AES-GCM", false, ["decrypt"]);
  const writer = output.getWriter();
  try {
    for (let index = 0; index < count; index++) {
      const chunk = await file.slice(index * (CHUNK + 16), (index + 1) * (CHUNK + 16)).arrayBuffer();
      await writer.write(new Uint8Array(await crypto.subtle.decrypt(parameters(descriptor, index), key, chunk)));
    }
    await writer.close();
  } catch (error) { await writer.abort(error).catch(() => {}); throw error; }
  finally { writer.releaseLock(); }
}
