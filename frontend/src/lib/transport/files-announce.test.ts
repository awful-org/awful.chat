import { beforeEach, describe, expect, it, vi } from "vitest";

// This suite exercises the released policy, including archived-room rejection.
vi.mock("$lib/room-security/invitation-release", () => ({ ROOM_SECURITY_V2_RELEASED: true }));

const sent: Array<{ peerId: string; infoHash: string }> = [];
const peerIdToDid = new Map<string, string>();

vi.mock("$lib/storage", () => ({
  attachmentEpoch: () => epoch,
  getSeedableFiles: async () => pendingRead ? pendingRead : seedable,
  getRoomParticipants: async (roomCode: string) => participants[roomCode] ?? [],
  getAttachmentsByInfoHash: async () => [],
  getAttachmentsWithData: async () => [],
  putAttachment: async () => {},
  updateAttachmentStatus: async () => {},
  updateAttachmentData: async () => {},
}));

vi.mock("./transport.svelte", () => ({
  _peerIdToDid: peerIdToDid,
  MAX_PERSISTED_ATTACHMENT_BYTES: 5 * 1024 * 1024,
  transportState: { fileTransfers: new Map() },
  _transport: {
    isRoomPeer: (room: string, peer: string) => (participants[room] ?? []).includes(peerIdToDid.get(peer) ?? ""),
    sendRoom: (peerId: string, _room: string, bytes: Uint8Array) => {
      const decoded = JSON.parse(new TextDecoder().decode(bytes));
      sent.push({ peerId, infoHash: decoded.payload.file.infoHash });
    },
  },
}));

vi.mock("$lib/utils", () => ({
  encode: (value: unknown) =>
    new TextEncoder().encode(JSON.stringify(value)),
}));

let epoch = 1;
let seedable: Array<{ roomCode: string; file: { infoHash: string } }> = [];
let pendingRead: Promise<typeof seedable> | null = null;
let participants: Record<string, string[]> = {};

const { _announceStoredFilesTo, _resetAttachmentHydration } = await import("./files.svelte");

const entry = (roomCode: string, infoHash: string) => ({
  roomCode,
  file: { infoHash, filename: "f.png", mimeType: "image/png", size: 1 },
});

describe("_announceStoredFilesTo", () => {
  beforeEach(() => {
    sent.length = 0;
    peerIdToDid.clear();
    epoch += 1;
    pendingRead = null;
    _resetAttachmentHydration();
  });

  it("announces files from rooms the peer shares, and only those", async () => {
    peerIdToDid.set("p1", "did:key:alice");
    seedable = [entry("rd2_a", "a"), entry("rd2_b", "b"), entry("dm-x", "c"), entry("legacy", "d")];
    participants = {
      "rd2_a": ["did:key:alice", "did:key:me"],
      "rd2_b": ["did:key:bob"],
      "dm-x": ["did:key:alice"],
      "legacy": ["did:key:alice"],
    };

    await _announceStoredFilesTo("p1");

    // The unrelated room and shared legacy archive must never be announced.
    expect(sent.map((s) => s.infoHash)).toEqual(["a", "c"]);
  });

  it("says nothing to a peer whose DID is not bound yet", async () => {
    seedable = [entry("rd2_a", "a")];
    participants = { "rd2_a": ["did:key:alice"] };

    await _announceStoredFilesTo("unknown-peer");

    expect(sent).toEqual([]);
  });

  it("does not announce or cache a previous identity's deferred inventory", async () => {
    peerIdToDid.set("p1", "did:key:alice");
    participants = { "dm-x": ["did:key:alice"] };
    let finish!: (rows: typeof seedable) => void;
    pendingRead = new Promise(resolve => { finish = resolve; });
    const previous = _announceStoredFilesTo("p1");
    _resetAttachmentHydration();
    pendingRead = null;
    seedable = [entry("dm-x", "new-identity-file")];
    finish([entry("dm-x", "old-identity-file")]);
    await previous;
    expect(sent).toEqual([]);
    await _announceStoredFilesTo("p1");
    expect(sent.map(s => s.infoHash)).toEqual(["new-identity-file"]);
  });
});
