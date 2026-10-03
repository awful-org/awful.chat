import { test } from "node:test";
import assert from "node:assert/strict";
import { bucketOf, clientKey, loadAdmissionConfig, originAllowed, PendingSockets } from "./admission";

test("origin: the app's DOMAIN and SFU_ALLOWED_ORIGINS, nothing else, once configured", () => {
  const cfg = loadAdmissionConfig({
    DOMAIN: "Chat.Example",
    SFU_ALLOWED_ORIGINS: "https://other.example:8443, not a url",
  });
  assert.equal(cfg.strict, true);
  assert.equal(originAllowed(cfg, "https://chat.example"), true);
  assert.equal(originAllowed(cfg, "https://CHAT.example"), true);
  assert.equal(originAllowed(cfg, "https://other.example:8443"), true);
  assert.equal(originAllowed(cfg, "https://evil.example"), false);
  assert.equal(originAllowed(cfg, "http://chat.example"), false);
  assert.equal(originAllowed(cfg, "https://chat.example.evil.example"), false);
  assert.equal(originAllowed(cfg, "null"), false);
  // Only browsers send Origin; a client that sends none is bounded by the
  // pending cap instead, as on the relay.
  assert.equal(originAllowed(cfg, undefined), true);
});

test("origin: the local dev stack, with nothing configured, accepts any origin", () => {
  const cfg = loadAdmissionConfig({ NODE_ENV: "development" });
  assert.equal(cfg.strict, false);
  assert.equal(originAllowed(cfg, "http://localhost:5173"), true);
});

test("origin: production with nothing configured refuses every browser", () => {
  const cfg = loadAdmissionConfig({ NODE_ENV: "production" });
  assert.equal(cfg.strict, true);
  assert.equal(originAllowed(cfg, "https://chat.example"), false);
});

test("client key: the socket peer, unless a trusted proxy names the client", () => {
  const cfg = loadAdmissionConfig({});
  // Direct: the peer is the client, and its X-Forwarded-For is its own word.
  assert.deepEqual(clientKey(cfg, "203.0.113.9", "198.51.100.1"), { key: "203.0.113.9", proxy: false });
  // Behind nginx or Caddy on the private network.
  assert.deepEqual(clientKey(cfg, "::ffff:10.0.1.4", "198.51.100.1, 203.0.113.7"), { key: "203.0.113.7", proxy: false });
  // A trusted hop in the chain (Traefik in front of nginx) is skipped.
  assert.deepEqual(clientKey(cfg, "10.0.1.4", "198.51.100.1, 10.0.1.2"), { key: "198.51.100.1", proxy: false });
  // A proxy that names nobody is its own bucket, with its own larger cap.
  assert.deepEqual(clientKey(cfg, "10.0.1.4", undefined), { key: "proxy:10.0.1.4", proxy: true });
  // IPv6 clients by /64.
  assert.equal(clientKey(cfg, "2001:db8:1:2::9", undefined).key, "2001:db8:1:2::/64");
  assert.equal(bucketOf("2001:db8:1:2:aaaa:bbbb:cccc:dddd"), "2001:db8:1:2::/64");
  assert.equal(bucketOf("2001:db8::1"), "2001:db8:0:0::/64");
  // An operator's own list replaces the private default.
  const only = loadAdmissionConfig({ SFU_TRUSTED_PROXY_CIDRS: "192.0.2.10" });
  assert.deepEqual(clientKey(only, "10.0.1.4", "198.51.100.1"), { key: "10.0.1.4", proxy: false });
  assert.deepEqual(clientKey(only, "192.0.2.10", "198.51.100.1"), { key: "198.51.100.1", proxy: false });
  assert.throws(() => loadAdmissionConfig({ SFU_TRUSTED_PROXY_CIDRS: "not-an-ip" }));
});

test("pending sockets: per client, per proxy and in total, and released once", () => {
  const cfg = loadAdmissionConfig({ SFU_MAX_PENDING_PER_IP: "2", SFU_MAX_PENDING_PER_PROXY: "3", SFU_MAX_PENDING: "5" });
  const pending = new PendingSockets(cfg);
  const a = { key: "203.0.113.1", proxy: false };
  const r1 = pending.tryAcquire(a);
  const r2 = pending.tryAcquire(a);
  assert.ok(r1 && r2);
  assert.equal(pending.tryAcquire(a), null);
  r1!();
  r1!(); // a second release is a no-op, not a free slot
  assert.ok(pending.tryAcquire(a));
  assert.equal(pending.tryAcquire(a), null);

  const proxy = { key: "proxy:10.0.0.2", proxy: true };
  assert.ok(pending.tryAcquire(proxy));
  assert.ok(pending.tryAcquire(proxy));
  assert.ok(pending.tryAcquire(proxy));
  // Five in total now: the global cap holds even for a fresh client.
  assert.equal(pending.size, 5);
  assert.equal(pending.tryAcquire({ key: "203.0.113.2", proxy: false }), null);
});
