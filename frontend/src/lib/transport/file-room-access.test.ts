import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  attachments: vi.fn(), participants: vi.fn(), isRoomPeer: vi.fn(),
  peers: new Map<string, string>(),
}));
vi.mock("$lib/storage", () => ({
  getAttachmentsByInfoHash: mocks.attachments,
  getRoomParticipants: mocks.participants,
}));
vi.mock("./transport.svelte", () => ({
  _peerIdToDid: mocks.peers,
  _transport: { isRoomPeer: mocks.isRoomPeer },
  transportState: {}, MAX_PERSISTED_ATTACHMENT_BYTES: 1024,
}));
vi.mock("$lib/media-prefs.svelte", () => ({ mediaPrefs: { autoDownloadMedia: false } }));
import { fileRoomForPeer } from "./files.svelte";

describe("file signaling authorization", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mocks.peers.clear();
    mocks.peers.set("peer", "did:peer");
    mocks.participants.mockResolvedValue(["did:peer"]);
    mocks.isRoomPeer.mockReturnValue(true);
  });
  it("requires the verified channel belonging to the requested file", async () => {
    mocks.attachments.mockResolvedValue([{ roomCode: "rd2_private" }]);
    expect(await fileRoomForPeer("peer", "hash", null)).toBeNull();
    expect(await fileRoomForPeer("peer", "hash", "rd2_other")).toBeNull();
    expect(await fileRoomForPeer("peer", "hash", "rd2_private")).toBe("rd2_private");
    mocks.isRoomPeer.mockReturnValue(false);
    expect(await fileRoomForPeer("peer", "hash", "rd2_private")).toBeNull();
  });
  it("does not serve an unknown hash or use another room's participant list", async () => {
    mocks.attachments.mockResolvedValue([]);
    expect(await fileRoomForPeer("peer", "hash")).toBeNull();
    mocks.attachments.mockResolvedValue([{ roomCode: "legacy-private" }]);
    mocks.participants.mockResolvedValue(["did:someone-else"]);
    expect(await fileRoomForPeer("peer", "hash")).toBeNull();
  });
  it("routes outgoing v2 signals through the verified room", async () => {
    mocks.attachments.mockResolvedValue([{ roomCode: "rd2_private" }]);
    expect(await fileRoomForPeer("peer", "hash")).toBe("rd2_private");
    expect(mocks.participants).not.toHaveBeenCalled();
  });
});
