// Real Chromium OPFS persistence across process restart. This exercises the
// production storage/crypto modules, not network torrent discovery or the UI.
// PLAYWRIGHT_MODULE and ESBUILD_MODULE may point to isolated installations.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { build } = require(process.env.ESBUILD_MODULE || "esbuild");
const bundle = await build({
  stdin: { contents: `import * as staging from './src/lib/room-security/file-staging';
    import * as durable from './src/lib/transport/file/ciphertext-store';
    window.files = { ...staging, ...durable };`,
    resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "ts" },
  bundle: true, write: false, platform: "browser", format: "esm",
});
const server = createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", req.url === "/client.js" ? "application/javascript" : "text/html");
  res.end(req.url === "/client.js" ? bundle.outputFiles[0].text :
    '<!doctype html><script type="module" src="/client.js"></script>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp(join(tmpdir(), "awful-opfs-test-"));
let context;
async function open() {
  context = await chromium.launchPersistentContext(profile, { headless: true });
  const page = await context.newPage();
  await page.goto(origin);
  await page.waitForFunction(() => !!window.files);
  return page;
}
try {
  let page = await open();
  // Exceeds one crypto chunk and cannot accidentally pass as an inline file.
  const saved = await page.evaluate(async () => {
    const source = new Uint8Array(5 * 1024 * 1024 + 123);
    for (let i = 0; i < source.length; i++) source[i] = i % 251;
    const staged = await window.files.stageEncryptedFile(new File([source], "private-name.txt", { type: "text/plain" }));
    const ciphertext = await staged.file.arrayBuffer();
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-1", ciphertext))]
      .map(b => b.toString(16).padStart(2, "0")).join("");
    await window.files.writeCiphertext(hash, staged.file);
    const result = { hash, descriptor: staged.encryption, name: staged.file.name, size: source.length };
    await staged.dispose();
    return result;
  });
  assert.notEqual(saved.name, "private-name.txt");
  assert.match(saved.name, /\.bin$/);
  await context.close();
  context = undefined;
  page = await open();
  const recovered = await page.evaluate(async saved => {
    const ciphertext = await window.files.readCiphertext(saved.hash);
    if (!ciphertext) throw new Error("Ciphertext lost on restart");
    const hash = [...new Uint8Array(await crypto.subtle.digest("SHA-1", await ciphertext.arrayBuffer()))]
      .map(b => b.toString(16).padStart(2, "0")).join("");
    const plaintext = await window.files.stageDecryptedFile(ciphertext, saved.descriptor, "private-name.txt", "text/plain");
    const bytes = new Uint8Array(await plaintext.file.arrayBuffer());
    const exact = bytes.length === saved.size && bytes.every((b, i) => b === i % 251);
    await plaintext.dispose();
    return { hash, exact };
  }, saved);
  assert.deepEqual(recovered, { hash: saved.hash, exact: true });
  console.log("PASS: real OPFS ciphertext survives browser-process restart with unchanged content hash and exact decryption");

  const tamper = await page.evaluate(async saved => {
    const ciphertext = await window.files.readCiphertext(saved.hash);
    const bytes = new Uint8Array(await ciphertext.arrayBuffer());
    bytes[bytes.length - 1] ^= 1;
    let rejected = false;
    try { await window.files.stageDecryptedFile(new Blob([bytes]), saved.descriptor, "secret.txt", "text/plain"); }
    catch { rejected = true; }
    const root = await navigator.storage.getDirectory();
    const staging = await root.getDirectoryHandle("room-v2-transfers");
    const entries = [];
    for await (const name of staging.keys()) entries.push(name);
    return { rejected, entries };
  }, saved);
  assert.deepEqual(tamper, { rejected: true, entries: [] });
  console.log("PASS: late-chunk tampering rejects plaintext publication and removes partial staging");

  const cancelled = await page.evaluate(async () => {
    const controller = new AbortController();
    const hash = "c".repeat(40);
    async function* chunks() {
      yield new Uint8Array(1024);
      controller.abort();
      yield new Uint8Array(1024);
    }
    let rejected = false;
    try { await window.files.writeCiphertext(hash, chunks(), controller.signal); }
    catch (error) { rejected = error.name === "AbortError"; }
    return { rejected, absent: await window.files.readCiphertext(hash) === null };
  });
  assert.deepEqual(cancelled, { rejected: true, absent: true });
  await page.evaluate(() => window.files.wipeCiphertext());
  assert.equal(await page.evaluate(hash => window.files.readCiphertext(hash), saved.hash), null);
  console.log("PASS: mid-write cancellation removes partial ciphertext; wipe removes durable recovery data");
} finally {
  await context?.close();
  await new Promise(resolve => server.close(resolve));
  await rm(profile, { recursive: true, force: true });
}
