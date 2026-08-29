import { describe, expect, it, vi } from "vitest";

// sync.svelte.ts pulls in LibP2PTransport, whose WebRTC dependency chain
// needs a native binding (node-datachannel) this test environment doesn't
// build. Nothing under test here touches the transport - it's pure
// string/JSON logic for the QR/short-code payload - so stub the import
// rather than pulling that whole stack in.
vi.mock("./libp2p/transport", () => ({ LibP2PTransport: class {} }));

import {
  generateShortCode,
  matchesSourcePeer,
  parsePlaintextToken,
  parseShortCode,
  peerIdShortPrefix,
} from "./sync.svelte";

// A realistic-shaped Ed25519 libp2p peerId: the constant "12D3KooW" multihash
// prefix followed by base58 key material.
const PEER_ID = "12D3KooWBmoLnSw8ChzC2K1LZjb1XkUJDihMAcqBRfsTGjfCgHz";
const ROOM_CODE = "__sync_deadbeef";
const TOKEN = "0123456789abcdef0123456789abcdef";

describe("peerIdShortPrefix", () => {
  it("takes the 8 chars right after the Ed25519 prefix", () => {
    expect(peerIdShortPrefix(PEER_ID)).toBe(PEER_ID.slice(8, 16));
    expect(peerIdShortPrefix(PEER_ID)).toBe("BmoLnSw8");
  });

  it("still returns chars [8,16) for a peerId without the expected prefix", () => {
    const oddPeerId = "notEd25519PrefixedPeerIdString";
    expect(peerIdShortPrefix(oddPeerId)).toBe(oddPeerId.slice(8, 16));
  });
});

describe("generateShortCode / parseShortCode round trip", () => {
  it("round-trips room, token and peer prefix through the 3-part short code", () => {
    const code = generateShortCode(ROOM_CODE, TOKEN, PEER_ID);
    expect(code.split("-")).toHaveLength(3);

    const parsed = parseShortCode(code);
    expect(parsed).toEqual({
      roomCode: ROOM_CODE,
      token: TOKEN.slice(0, 8),
      peerPrefix: peerIdShortPrefix(PEER_ID),
    });
  });

  it("rejects a 2-part (pre-peerId-pinning) short code", () => {
    expect(parseShortCode("deadbeef-01234567")).toBeNull();
  });

  it("rejects segments of the wrong length", () => {
    expect(parseShortCode("short-01234567-BmoLnSw8")).toBeNull();
  });
});

describe("parsePlaintextToken", () => {
  it("accepts a well-formed 3-part short code and carries the peerPrefix", () => {
    const code = generateShortCode(ROOM_CODE, TOKEN, PEER_ID);
    const payload = parsePlaintextToken(code);
    expect(payload).not.toBeNull();
    expect(payload!.roomCode).toBe(ROOM_CODE);
    expect(payload!.token).toBe(TOKEN.slice(0, 8));
    expect(payload!.peerPrefix).toBe(peerIdShortPrefix(PEER_ID));
    expect(payload!.peerId).toBeUndefined();
  });

  it("rejects the old 2-part short code with a clear update-both-devices error", () => {
    expect(() => parsePlaintextToken("deadbeef-01234567")).toThrow(
      /update both devices/i
    );
  });

  it("accepts the 3-part full (colon-delimited) format with a peerId", () => {
    const payload = parsePlaintextToken(`${ROOM_CODE}:${TOKEN}:${PEER_ID}`);
    expect(payload).not.toBeNull();
    expect(payload!.roomCode).toBe(ROOM_CODE);
    expect(payload!.token).toBe(TOKEN);
    expect(payload!.peerId).toBe(PEER_ID);
    expect(payload!.peerPrefix).toBeUndefined();
  });

  it("rejects the old 2-part full format (room:token, no peerId)", () => {
    expect(() => parsePlaintextToken(`${ROOM_CODE}:${TOKEN}`)).toThrow(
      /update both devices/i
    );
  });

  it("returns null for garbage input", () => {
    expect(parsePlaintextToken("not a sync code")).toBeNull();
    expect(parsePlaintextToken("")).toBeNull();
  });
});

describe("matchesSourcePeer", () => {
  it("matches on the full peerId when the payload carries one", () => {
    expect(matchesSourcePeer({ peerId: PEER_ID } as never, PEER_ID)).toBe(
      true
    );
    expect(
      matchesSourcePeer({ peerId: PEER_ID } as never, "someOtherPeerId12345")
    ).toBe(false);
  });

  it("matches on the peerPrefix when the payload only carries that", () => {
    const prefix = peerIdShortPrefix(PEER_ID);
    expect(matchesSourcePeer({ peerPrefix: prefix } as never, PEER_ID)).toBe(
      true
    );
    expect(
      matchesSourcePeer({ peerPrefix: "ZZZZZZZZ" } as never, PEER_ID)
    ).toBe(false);
  });

  it("refuses to match anything when the payload has neither", () => {
    expect(matchesSourcePeer({} as never, PEER_ID)).toBe(false);
  });
});
