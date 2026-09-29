// Production identity + encrypted IndexedDB + OPFS + WebTorrent in real Chromium.
// Signaling is bridged by the runner; room admission/UI are outside this harness.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { createServer } = await import("vite");
const { nodePolyfills } = await import("vite-plugin-node-polyfills");
const { svelte } = await import("@sveltejs/vite-plugin-svelte");
const root = fileURLToPath(new URL("../", import.meta.url));
const entry = `
import * as storage from '/src/lib/storage.ts';
import * as identity from '/src/lib/identity/identity.ts';
import * as durable from '/src/lib/transport/file/ciphertext-store.ts';
import { WebTorrentFileTransport } from '/src/lib/transport/file/webtorrent.ts';
import * as files from '/src/lib/transport/files.svelte.ts';
window.api = { storage, identity, durable, files, transportState: window.fixtureState, WebTorrentFileTransport };
`;
const server = await createServer({ root, configFile: false,
  optimizeDeps: { entries: [], include: ["vite-plugin-node-polyfills/shims/buffer", "vite-plugin-node-polyfills/shims/global", "vite-plugin-node-polyfills/shims/process", "simple-peer", "webtorrent", "idb", "@noble/curves/ed25519.js", "@scure/base", "@scure/bip39", "@scure/bip39/wordlists/english.js", "clsx", "tailwind-merge", "@noble/hashes/sha2.js", "@noble/hashes/hkdf.js"] },
  cacheDir: join(await mkdtemp(join(tmpdir(), "awful-recovery-vite-")), "cache"),
  define: { global: "globalThis", __APP_VERSION__: '"test"', __APP_COMMIT__: '"test"' },
  resolve: { alias: { $lib: join(root, "src/lib") } },
  plugins: [svelte(), nodePolyfills(), { name: "recovery-fixture", enforce: "pre",
    resolveId(id, importer) {
      if (id === 'virtual:recovery-core' || (id === './transport.svelte' && importer?.endsWith('/transport/files.svelte.ts'))) return '\0recovery-core';
    },
    load(id) {
      if (id === '\0recovery-core') return `export const transportState = window.fixtureState = { fileTransfers: new Map() };
        export const _peerIdToDid = new Map();
        export const MAX_PERSISTED_ATTACHMENT_BYTES = 5 * 1024 * 1024;
        export const _transport = { peers: () => [], isRoomPeer: () => false, sendRoom: () => {} };`;
    },
    configureServer(server) {
    server.middlewares.use((req, res, next) => {
      if (req.url === "/recovery") { res.setHeader("Content-Type", "text/html"); res.end('<script type="module" src="/recovery-entry.js"></script>'); }
      else if (req.url === "/recovery-entry.js") { res.setHeader("Content-Type", "application/javascript"); res.end(entry); }
      else next();
    });
  } }], server: { host: "127.0.0.1", port: 0 },
});
await server.listen();
const origin = `http://127.0.0.1:${server.httpServer.address().port}`;
const profiles = await Promise.all([0, 1].map(() => mkdtemp(join(tmpdir(), "awful-recovery-profile-"))));
const contexts = [];
const errors = [];
async function open(index) {
  const context = await chromium.launchPersistentContext(profiles[index], { headless: true });
  contexts[index] = context;
  const page = await context.newPage();
  page.on("pageerror", error => { errors.push(error.message); console.error("PAGE", error.message); });
  await page.goto(`${origin}/recovery`);
  await page.waitForFunction(() => !!window.api, null, { timeout: 60000 });
  return page;
}
const password = "attachment-browser-test-password";
const size = 5 * 1024 * 1024 + 123;
try {
  let sender = await open(0);
  const hash = await sender.evaluate(async ({ password, size }) => {
    const { identity, storage, WebTorrentFileTransport } = window.api;
    await identity.createIdentity(password);
    window.transport = new WebTorrentFileTransport(() => "sender");
    const bytes = Uint8Array.from({ length: size }, (_, i) => i % 251);
    const [descriptor] = await window.transport.seedEncryptedFiles([new File([bytes], "private-name.txt", { type: "text/plain" })]);
    await storage.putAttachment({ ...descriptor, id: "recovery-attachment", messageId: "recovery-message", roomCode: "rd2_recovery", createdAt: Date.now(), status: "seeding" });
    const raw = await (await storage.getDB()).get("attachments", "recovery-attachment");
    if (!raw._enc || JSON.stringify(raw).includes(descriptor.encryption.key) || JSON.stringify(raw).includes("private-name.txt")) throw new Error("Descriptor not sealed");
    return descriptor.infoHash;
  }, { password, size });
  await contexts[0].close();
  contexts[0] = undefined;
  sender = await open(0);
  const descriptor = await sender.evaluate(async password => {
    const { identity, storage, files, transportState, WebTorrentFileTransport } = window.api;
    await identity.unlockIdentity(password);
    const row = await storage.getAttachment("recovery-attachment");
    if (!row?.encryption || row.data) throw new Error("Expected DB descriptor and OPFS-only ciphertext");
    window.transport = new WebTorrentFileTransport(() => "sender");
    files.initFiles(window.transport);
    await files._hydrateAndSeedAttachments(row.roomCode);
    if (!window.transport.getTransfer(row.infoHash)?.seeding) throw new Error("Restore failed");
    if (!transportState.fileTransfers.get(row.infoHash)?.blobURL) throw new Error("Hydration did not publish attachment UI URL");
    const { infoHash, filename, mimeType, size, encryption } = row;
    return { infoHash, filename, mimeType, size, encryption };
  }, password);
  assert.equal(descriptor.infoHash, hash);
  console.log("PASS: actual identity unlock restores encrypted DB descriptor after browser restart; OPFS ciphertext re-seeds original torrent hash");

  const receiver = await open(1);
  await receiver.evaluate(() => {
    window.transport = new window.api.WebTorrentFileTransport(() => "receiver");
    window.downloads = 0;
    window.transport.on("downloaded", () => window.downloads++);
  });
  await sender.exposeFunction("relaySignal", (_, envelope) => receiver.evaluate(envelope => window.transport.handleSignal("sender", envelope), envelope));
  await receiver.exposeFunction("relaySignal", (_, envelope) => sender.evaluate(envelope => window.transport.handleSignal("receiver", envelope), envelope));
  for (const [page, peer] of [[sender, "receiver"], [receiver, "sender"]]) {
    await page.evaluate(peer => {
      window.transport.on("signal", (target, envelope) => { void window.relaySignal(target, envelope); });
      window.transport.onPeerConnect(peer);
    }, peer);
  }
  await receiver.evaluate(descriptor => {
    window.transport.registerSeeder(descriptor, "sender");
    window.transport.ensureDownload(descriptor);
  }, descriptor);
  await receiver.waitForFunction(hash => window.transport.getTransfer(hash)?.done, hash, { timeout: 90000 });
  assert.deepEqual(await receiver.evaluate(async ({ hash, size }) => {
    const state = window.transport.getTransfer(hash);
    const bytes = new Uint8Array(await (await fetch(state.blobURL)).arrayBuffer());
    return { exact: bytes.length === size && bytes.every((b, i) => b === i % 251), downloads: window.downloads, durable: !!await window.api.durable.readCiphertext(hash) };
  }, { hash, size }), { exact: true, downloads: 1, durable: true });
  console.log("PASS: second Chromium process downloads via production SimplePeer/WebTorrent/OPFS, authenticates every chunk, and publishes exact plaintext once");

  // Real network transfer with a wrong authenticated descriptor key must never
  // publish plaintext, even though every torrent piece passes its SHA-1 check.
  await receiver.evaluate(descriptor => {
    window.transport.resetTransfers();
    window.downloads = 0;
    const wrong = structuredClone(descriptor);
    wrong.encryption.key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32)))).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
    window.transport.registerSeeder(wrong, "sender");
    window.transport.ensureDownload(wrong);
  }, descriptor);
  await receiver.waitForFunction(hash => window.transport.getTransfer(hash)?.status === "failed", hash, { timeout: 90000 });
  assert.deepEqual(await receiver.evaluate(async hash => {
    const transfer = window.transport.getTransfer(hash);
    return { published: !!transfer.blobURL, downloads: window.downloads, durable: !!await window.api.durable.readCiphertext(hash) };
  }, hash), { published: false, downloads: 0, durable: false });
  console.log("PASS: production network download with wrong descriptor key fails closed, publishes no plaintext, and removes durable ciphertext");

  const lifecycle = await sender.evaluate(async ({ hash, password }) => {
    const { identity, storage, durable } = window.api;
    const row = await storage.getAttachment("recovery-attachment");
    const oldURL = window.transport.getTransfer(hash).blobURL;
    window.transport.resetTransfers();
    let revoked = false;
    try { await fetch(oldURL); } catch { revoked = true; }
    const pending = window.transport.restoreEncryptedFile(row);
    window.transport.resetTransfers();
    let cancelled = false;
    try { await pending; } catch { cancelled = true; }
    const empty = window.transport.getTransfers().length === 0;
    identity.lockIdentity();
    let locked = false;
    try { locked = !await storage.getAttachment("recovery-attachment"); } catch { locked = true; }
    await identity.unlockIdentity(password);
    const restoredRow = await storage.getAttachment("recovery-attachment");
    const original = await durable.readCiphertext(hash);
    const bytes = new Uint8Array(await original.arrayBuffer());
    bytes[bytes.length - 1] ^= 1;
    await durable.writeCiphertext(hash, new Blob([bytes]));
    let tamperRejected = false;
    try { await window.transport.restoreEncryptedFile(restoredRow); } catch { tamperRejected = true; }
    const noPublication = window.transport.getTransfers().length === 0;
    const staging = await (await navigator.storage.getDirectory()).getDirectoryHandle("room-v2-transfers");
    const entries = [];
    for await (const name of staging.keys()) entries.push(name);
    await durable.wipeCiphertext();
    const wiped = await durable.readCiphertext(hash) === null;
    return { revoked, cancelled, empty, locked, tamperRejected, noPublication, entries, wiped };
  }, { hash, password });
  assert.deepEqual(lifecycle, { revoked: true, cancelled: true, empty: true, locked: true, tamperRejected: true, noPublication: true, entries: [], wiped: true });
  assert.deepEqual(errors, []);
  console.log("PASS: reset revokes plaintext URL and cancels pending restore; identity lock denies DB descriptor; late OPFS tamper rejects restore with no staging remnants; wipe removes recovery bytes");
} finally {
  await Promise.all(contexts.map(context => context?.close()));
  await server.close();
  await Promise.all(profiles.map(profile => rm(profile, { recursive: true, force: true })));
  await rm(join(server.config.cacheDir, ".."), { recursive: true, force: true });
}
