import { describe, expect, it } from "vitest";
import { generateKeyPairFromSeed } from "@libp2p/crypto/keys";
import { peerIdFromPrivateKey } from "@libp2p/peer-id";
import { signSfuJoin } from "./sfu-auth";
import { verifyJoin } from "../../../../sfu/auth";

describe("browser/SFU identity proof interoperability", () => {
  it("verifies the browser signature against the actual libp2p peer ID", async () => {
    const seed = crypto.getRandomValues(new Uint8Array(32));
    const key = await generateKeyPairFromSeed("Ed25519", seed);
    const peer = peerIdFromPrivateKey(key).toString();
    const nonce = "a".repeat(64);
    const sig = signSfuJoin(seed, nonce, "room", peer);
    expect(verifyJoin(nonce, "room", peer, sig)).toBe(true);
    expect(verifyJoin("b".repeat(64), "room", peer, sig)).toBe(false);
    expect(verifyJoin(nonce, "different-room", peer, sig)).toBe(false);
  });
  it("does not sign an arbitrary or malformed server challenge", () => {
    expect(() => signSfuJoin(new Uint8Array(32), "arbitrary signing input", "room", "peer")).toThrow();
  });
});
