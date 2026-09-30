import { beforeEach, expect, it, vi } from "vitest";
import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";

// Every authenticated mailbox call carries a v2 proof: a signature over the
// action, the relay's host, the device, the time and the exact body. These
// pin the wire shape the relay checks (relay/mailbox.go).
vi.mock("./transport.svelte", () => ({
  _transport: { selfId: () => "12D3KooWDevice" },
  broadcastProfile: () => {},
  deliverMailboxBatch: async () => {},
  deliverMailboxDm: async () => {},
  deliverMailboxReceipt: async () => {},
}));
vi.mock("$lib/runtime-config", () => ({ apiUrl: () => "https://Relay.Test:8443" }));
const key = crypto.getRandomValues(new Uint8Array(32));
vi.mock("$lib/identity/identity", async (original) => {
  const real = await original<typeof import("$lib/identity/identity")>();
  return {
    ...real,
    isUnlocked: () => true,
    requireSession: () => ({ did: "did:key:test", privateKey: key }),
  };
});
vi.mock("$lib/mailbox-crypto", async (original) => {
  const real = await original<typeof import("$lib/mailbox-crypto")>();
  // Every blob opens as a chat message, so collect goes on to ack it.
  return {
    ...real,
    openDmFromMailbox: async () => ({
      senderDid: "did:key:sender",
      envelope: new Uint8Array([1]),
      kind: "chat",
    }),
  };
});
vi.mock("./dm-codec", () => ({
  parseDmEnvelope: () => ({ type: "chat", payload: {} }),
}));

import { collectMailbox, mailboxAuthMessage } from "./mailbox.svelte";

const hex = (u: Uint8Array) =>
  Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");

interface Sent {
  url: string;
  auth: string;
  body: string;
}
const sent: Sent[] = [];

beforeEach(() => {
  sent.length = 0;
  vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
    const headers = init.headers as Record<string, string>;
    sent.push({ url, auth: headers.Authorization, body: init.body as string });
    if (url.endsWith("/mailbox/collect")) {
      return new Response(JSON.stringify([{ id: "abc", blob: "AA==" }]), { status: 200 });
    }
    return new Response(null, { status: 204 });
  });
});

function verify(s: Sent, action: string): Record<string, unknown> {
  const m = /^AwfulMailbox-v2 (\S+) (\d+) (\S+)$/.exec(s.auth);
  expect(m).not.toBeNull();
  const [, did, ts, sig] = m!;
  expect(did).toBe("did:key:test");
  const body = JSON.parse(s.body);
  // The host as the URL addresses it: lowercased, port kept.
  const msg = mailboxAuthMessage(action as never, "relay.test:8443", body.device, Number(ts), s.body);
  const sigBytes = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
  expect(ed25519.verify(sigBytes, new TextEncoder().encode(msg), ed25519.getPublicKey(key))).toBe(true);
  // Signed as THIS action only.
  const asOther = mailboxAuthMessage("push-unsubscribe", "relay.test:8443", body.device, Number(ts), s.body);
  expect(ed25519.verify(sigBytes, new TextEncoder().encode(asOther), ed25519.getPublicKey(key))).toBe(false);
  return body;
}

it("signs collect and ack each as themselves, with the device and a nonce in the body", async () => {
  await collectMailbox();
  expect(sent.map((s) => s.url)).toEqual([
    "https://Relay.Test:8443/mailbox/collect",
    "https://Relay.Test:8443/mailbox/ack",
  ]);
  const collect = verify(sent[0], "collect");
  const ack = verify(sent[1], "ack");
  expect(collect.device).toBe("12D3KooWDevice");
  expect(ack).toMatchObject({ device: "12D3KooWDevice", ids: ["abc"] });
  // No v1 fields: the proof is the header, not a body the relay would
  // otherwise also take as a legacy proof.
  expect(collect).not.toHaveProperty("sig");
  expect(ack).not.toHaveProperty("sig");
  expect(collect.nonce).not.toBe(ack.nonce);
});

// The same vector relay/mailbox_auth_test.go pins, so the two sides cannot
// drift apart on the format.
it("builds the signed string exactly as the relay does", () => {
  const body = '{"ids":["abc"],"device":"dev","nonce":"00"}';
  expect(hex(sha256(new TextEncoder().encode(body)))).toBe(
    "26215402fa91f88e5b53ca396aea66a1d15dc0fa399ffacc7084ef9fba2f12e6"
  );
  expect(mailboxAuthMessage("ack", "relay.test", "dev", 1700000000, body)).toBe(
    "awful-mailbox:v2:ack:relay.test:dev:1700000000:26215402fa91f88e5b53ca396aea66a1d15dc0fa399ffacc7084ef9fba2f12e6"
  );
});
