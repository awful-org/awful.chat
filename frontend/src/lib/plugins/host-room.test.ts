import { beforeEach, expect, it, vi } from "vitest";

const { sendCard, transportState, rows, restore, request } = vi.hoisted(() => ({
  sendCard: vi.fn(async () => "card-id"),
  transportState: { roomCode: "room-a", fileTransfers: new Map() },
  rows: [] as any[], restore: vi.fn(), request: vi.fn(),
}));
vi.mock("$lib/transport/transport.svelte", () => ({ sendCard, transportState, onBeforeDisconnect: vi.fn(), restoreFileAttachment: restore, requestFileDownload: request }));
vi.mock("$lib/identity/identity.svelte", () => ({ identityStore: {} }));
vi.mock("$lib/identity/identity", () => { const session = {}; return { requireSession: () => session }; });
vi.mock("$lib/storage", () => ({ getAttachmentsByInfoHash: async () => rows }));
vi.mock("$lib/ui-state.svelte", () => ({}));
vi.mock("./media-session", () => ({}));
vi.mock("./state.svelte", () => ({}));
vi.mock("./local-cards.svelte", () => ({ closeLocalCard: vi.fn() }));
vi.mock("$lib/transport/voice.svelte", () => ({
  getCallAudioBlockedReason: vi.fn(), getCallCaptureBlockedReason: vi.fn(),
  getCallCaptureStreams: vi.fn(), onCallCaptureChange: vi.fn(),
}));
vi.mock("$lib/audio/call-audio-mixer", () => ({ CALL_SOUND_MAX_DURATION_MS: 1000 }));

import { makeHostApi } from "./host";
import { encryptFileTo, decryptFileTo } from "$lib/room-security/file-crypto";
beforeEach(() => { vi.clearAllMocks(); rows.length = 0; transportState.fileTransfers.clear(); });

it("keeps background plugin cards in their host room across active-room changes", async () => {
  const host = makeHostApi("test-plugin", "room-a");
  transportState.roomCode = "room-b";
  const payload = { private: "room-a-only" };
  expect(await host.sendCard(payload)).toBe("card-id");
  expect(sendCard).toHaveBeenCalledExactlyOnceWith("test-plugin", payload, "room-a");
});

it.each([true, false])("resolves protected image plaintext through authentication (DB bytes: %s)", async inDatabase => {
  const plaintext = new Uint8Array([137, 80, 78, 71, 0, 255, 42]);
  const chunks: Uint8Array[] = [];
  const encryption = await encryptFileTo(new Blob([plaintext]), new WritableStream({ write(chunk) { chunks.push(chunk); } }));
  const ciphertext = new Blob(chunks as BlobPart[]);
  const row = { roomCode: "room-a", infoHash: "image", mimeType: "image/png", size: plaintext.length,
    filename: "private.png", encryption, data: inDatabase ? await ciphertext.arrayBuffer() : undefined };
  rows.push(row);
  let url = "";
  restore.mockImplementationOnce(async (descriptor) => {
    const output: Uint8Array[] = [];
    await decryptFileTo(descriptor.data ? new Blob([descriptor.data]) : ciphertext, descriptor.encryption,
      new WritableStream({ write(chunk) { output.push(chunk); } }));
    url = URL.createObjectURL(new Blob(output as BlobPart[], { type: descriptor.mimeType }));
    transportState.fileTransfers.set("image", { blobURL: url });
    return true;
  });
  try {
    const result = await makeHostApi("test", "room-a").resolveRoomImage("image");
    expect(new Uint8Array(await result!.arrayBuffer())).toEqual(plaintext);
    expect(restore).toHaveBeenCalledExactlyOnceWith(row);
    expect(request).not.toHaveBeenCalled();
  } finally { URL.revokeObjectURL(url); }
});

it("keeps the protected descriptor on a missing-image download and refuses foreign rooms", async () => {
  const encryption = { key: "secret" };
  rows.push({ roomCode: "other", infoHash: "image", mimeType: "image/png", encryption });
  const host = makeHostApi("test", "room-a");
  expect(await host.resolveRoomImage("image", { timeoutMs: 0 })).toBeNull();
  expect(restore).not.toHaveBeenCalled(); expect(request).not.toHaveBeenCalled();
  rows[0].roomCode = "room-a";
  restore.mockResolvedValueOnce(false);
  expect(await host.resolveRoomImage("image", { timeoutMs: 0 })).toBeNull();
  expect(request).toHaveBeenCalledWith(expect.objectContaining({ infoHash: "image", encryption }));
});
