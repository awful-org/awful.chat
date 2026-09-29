import type { FileEntry } from "../types/message";
import { validateFileEncryption } from "./file-crypto";

export function encryptedFileSize(file: FileEntry): number {
  if (!file.encryption) return file.size;
  validateFileEncryption(file.encryption);
  if (file.size !== file.encryption.size) throw new Error("Encrypted file size mismatch");
  return file.size + Math.max(1, Math.ceil(file.size / file.encryption.chunkSize)) * 16;
}

export function opaqueFileName(file: Pick<FileEntry, "encryption">): string {
  if (!file.encryption) throw new Error("Encrypted file descriptor required");
  validateFileEncryption(file.encryption);
  return `${file.encryption.id}.bin`;
}

/** Apply before live/history storage, including unsigned historical DM rows. */
export function acceptsFileDescriptors(room: string | null | undefined, files: FileEntry[] | undefined): boolean {
  if (!room?.startsWith("rd2_") && !room?.startsWith("dm-")) return true;
  if (!Array.isArray(files) || !files.length) return false;
  try {
    return files.every(file => !!file.encryption && Number.isFinite(encryptedFileSize(file)));
  } catch { return false; }
}

/** Canonical identity-signature input. Legacy signature bytes are unchanged. */
export function fileSignatureBinding(file: FileEntry): string {
  const legacy = `${file.infoHash}:${file.size}:${file.mimeType}:${file.filename}`;
  if (!file.encryption) return legacy;
  encryptedFileSize(file);
  const e = file.encryption;
  return JSON.stringify(["awful:file-descriptor:v2", file.infoHash, file.size,
    file.mimeType, file.filename, e.version, e.key, e.id, e.size, e.chunkSize,
    file.width ?? null, file.height ?? null]);
}
