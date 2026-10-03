// Tests unmodified production dist pages and workers, never fixture pages.
// Supply OLD_DIST and NEW_DIST built in isolated trees (new release gate enabled).
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createServer as createTlsServer } from "node:tls";
import { connect as connectTcp } from "node:net";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { resolve, extname, join } from "node:path";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const oldDist = resolve(process.env.OLD_DIST);
const newDist = resolve(process.env.NEW_DIST);
const scriptFor = async dir => (await readFile(join(dir, "index.html"), "utf8"))
  .match(/<script[^>]+src="([^"]+)"/)[1];
const oldScript = await scriptFor(oldDist), newScript = await scriptFor(newDist);
assert.notEqual(oldScript, newScript, "old and new app bundles must differ");
assert.match(await readFile(join(newDist, "sw.js"), "utf8"), /awful-room-security-cutover-v2/);
let dist = oldDist, failAsset = false, later = false;
assert.ok(process.env.RELAY_MULTIADDR, "RELAY_MULTIADDR required for authentic old-app population");
// TLS termination only; all libp2p/Noise room traffic reaches the real relay.
const tlsRelay = createTlsServer({ key: await readFile(process.env.RELAY_TLS_KEY), cert: await readFile(process.env.RELAY_TLS_CERT) }, socket => {
  const upstream = connectTcp(8080, "127.0.0.1");
  socket.pipe(upstream).pipe(socket);
  socket.on("error", () => upstream.destroy()); upstream.on("error", () => socket.destroy());
});
await new Promise(r => tlsRelay.listen(0, "127.0.0.1", r));
const relayAddr = `/dns4/relay.example.test/tcp/${tlsRelay.address().port}/wss/p2p/${process.env.RELAY_MULTIADDR.split("/").at(-1)}`;
const requests = [];
const mime = { ".js": "application/javascript", ".html": "text/html", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm", ".svg": "image/svg+xml", ".png": "image/png", ".webmanifest": "application/manifest+json" };
const server = createServer(async (req, res) => {
  const pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
  requests.push({ pathname, build: dist === oldDist ? "old" : "new" });
  res.setHeader("Cache-Control", "no-store");
  if (pathname === "/config.json") {
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ apiUrl: "/api", relayMultiaddr: relayAddr, sfuUrls: [], useQc: false, useQs: false })); return;
  }
  if (failAsset && pathname === newScript) { res.writeHead(503); res.end("install failure"); return; }
  try {
    let path = resolve(dist, `.${pathname}`);
    if (!path.startsWith(dist + "/") && path !== dist) throw new Error("invalid path");
    if (!extname(path)) path = join(dist, "index.html");
    let bytes = await readFile(path);
    // A later deployment differs only in worker bytes; app/manifest remain real.
    if (pathname === "/sw.js" && later) bytes = Buffer.concat([bytes, Buffer.from("\n// ordinary subsequent deployment\n")]);
    res.setHeader("Content-Type", mime[extname(path)] || "application/octet-stream");
    res.end(bytes);
  } catch { res.writeHead(404); res.end(); }
});
await new Promise(r => server.listen(0, "0.0.0.0", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const profile = await mkdtemp("/tmp/pwa-bundled-profile-");
let context;
const errors = [];
const roomName = "Bundled upgrade saved room";
const messageText = "Old bundle message survives security cutover";
const attachmentName = "bundled-upgrade-evidence.txt";
const attachmentText = "Authentic old-app attachment bytes: preserved across PWA upgrade.\n";
const readabilityFailures = [];
async function readable(p) {
  await p.getByText(roomName, { exact: true }).first().click();
  await p.getByText(messageText, { exact: true }).waitFor();
  const download = p.locator(`a[download="${attachmentName}"]`);
  await download.waitFor();
  const [saved] = await Promise.all([p.waitForEvent("download"), download.click()]);
  assert.equal(saved.suggestedFilename(), attachmentName);
  assert.equal((await readFile(await saved.path())).toString(), attachmentText);
}
async function verifyUpgradedReadability(p, stage) {
  try {
    await readable(p);
    const archive = p.getByRole("region", { name: "Legacy room archive" });
    await archive.waitFor();
    assert.match(await archive.innerText(), /Read-only legacy archive/);
    for (const name of ["Send message", "Join call", "Invite people"]) {
      assert.equal(await p.getByRole("button", { name, exact: true }).count(), 0, `${name} unavailable in archive`);
    }
    assert.equal(await archive.locator('textarea, input[type="file"], [contenteditable="true"]').count(), 0);
    await p.getByRole("button", { name: "Close archive", exact: true }).click();
    await readable(p);
    console.log(`PASS ${stage}: UI reads saved room/message and downloads exact original attachment bytes`);
  } catch (error) {
    readabilityFailures.push(stage);
    console.error(`FAIL ${stage}: ${error.message}`);
    console.error("READABILITY PAGE", await p.locator("body").innerText());
  }
}
async function launch() {
  context = await chromium.launchPersistentContext(profile, { headless: true, args: ["--no-sandbox", "--ignore-certificate-errors", "--host-resolver-rules=MAP relay.example.test 127.0.0.1"] });
  context.setDefaultTimeout(30000);
  if (process.env.TRACE_CUTOVER) context.on("console", msg => console.log("BROWSER", msg.text()));
  if (process.env.TRACE_CUTOVER) {
    const cdp = await context.newCDPSession(context.pages()[0]);
    cdp.on("ServiceWorker.workerVersionUpdated", event => console.log("VERSIONS", JSON.stringify(event)));
    await cdp.send("ServiceWorker.enable");
  }
  await context.addInitScript(() => {
    if (location.protocol === "http:") sessionStorage.bundleLoads = String(Number(sessionStorage.bundleLoads || 0) + 1);
  });
  context.on("page", p => p.on("pageerror", e => errors.push(String(e))));
}
async function ready(p) {
  await p.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await p.waitForFunction(() => !!navigator.serviceWorker.controller);
}
async function bundle(p, src, timeout = 30000) { await p.waitForFunction(src => [...document.scripts].some(s => s.getAttribute("src") === src), src, { timeout }); }
async function update(p) { await p.evaluate(() => { void navigator.serviceWorker.getRegistration().then(r => r.update()); }); }
async function snapshot(p) {
  return p.evaluate(async () => {
    const output = {};
    function json(value) {
      if (value instanceof ArrayBuffer) return { bytes: Array.from(new Uint8Array(value)) };
      if (ArrayBuffer.isView(value)) return { bytes: Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength)) };
      if (Array.isArray(value)) return value.map(json);
      if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k,v]) => [k,json(v)]));
      return value;
    }
    for (const { name } of await indexedDB.databases()) {
      if (name !== "awful-chat") continue;
      const db = await new Promise((resolve,reject) => { const r=indexedDB.open(name); r.onsuccess=()=>resolve(r.result); r.onerror=()=>reject(r.error); });
      const stores = {};
      for (const store of db.objectStoreNames) {
        if (store === "diagnostics") continue; // runtime telemetry changes legitimately
        stores[store] = await new Promise((resolve,reject) => { const r=db.transaction(store).objectStore(store).getAll(); r.onsuccess=()=>resolve(json(r.result)); r.onerror=()=>reject(r.error); });
      }
      output[name] = { version: db.version, stores }; db.close();
    }
    return output;
  });
}
try {
  await launch();
  let a = await context.newPage();
  await a.goto(origin + "/app"); await ready(a);
  await a.getByRole("button", { name: "Got it", exact: true }).click();
  await a.getByRole("button", { name: "Create new identity", exact: true }).click();
  await a.locator("#create-password").fill("bundled-cutover-password");
  await a.locator("#create-password-confirm").fill("bundled-cutover-password");
  await a.getByRole("button", { name: "Create identity", exact: true }).click();
  await a.getByRole("checkbox", { name: /written down my recovery/ }).check();
  await a.getByRole("button", { name: "I'm ready", exact: true }).click();
  await a.getByPlaceholder("Your display name").fill("Cutover preserved profile");
  await a.getByRole("button", { name: "Done", exact: true }).click();
  if (await a.getByRole("button", { name: "Skip for now", exact: true }).isVisible()) await a.getByRole("button", { name: "Skip for now", exact: true }).click();
  await a.getByPlaceholder("Room name (optional)").fill(roomName);
  await a.getByRole("button", { name: "Create room", exact: true }).click();
  await a.getByRole("button", { name: "Join room", exact: true }).click();
  await a.getByPlaceholder("Type a message...").fill(messageText);
  await a.getByRole("button", { name: "Send message", exact: true }).click();
  await a.getByText(messageText, { exact: true }).waitFor();
  await a.locator('input[type="file"]').setInputFiles({ name: attachmentName, mimeType: "text/plain", buffer: Buffer.from(attachmentText) });
  await a.getByRole("button", { name: "Send message", exact: true }).click();
  await readable(a);
  console.log("PASS authentic old app UI created room, message and downloadable attachment; no stored-format fixtures");
  await a.evaluate(() => localStorage.setItem("bundled-cutover-sentinel", "preserved"));
  const before = await snapshot(a);
  assert.ok(Object.values(before).some(d => d.stores.identity?.length), "actual app-created identity exists");
  for (const store of ["rooms", "messages", "attachments"]) assert.ok(before["awful-chat"].stores[store].length, `${store} must be populated`);
  console.log("PASS app-created identity/database", Object.fromEntries(Object.entries(before).map(([n,d]) => [n,{version:d.version,rows:Object.fromEntries(Object.entries(d.stores).map(([k,v])=>[k,v.length]))}])));
  await context.close();
  await launch(); await context.setOffline(true);
  a = await context.newPage(); await a.goto(origin + "/app"); await ready(a); await bundle(a, oldScript);
  await a.locator("#unlock-password").waitFor();
  assert.deepEqual(await snapshot(a), before);
  console.log("PASS old installed bundle cold offline startup and database persistence");
  await context.setOffline(false);
  const b = await context.newPage(); await b.goto(origin + "/app"); await ready(b); await bundle(b, oldScript);
  dist = newDist; failAsset = true;
  await a.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration(); await r.update();
    const w = r.installing;
    if (w && w.state !== "redundant") await new Promise(resolve => w.addEventListener("statechange", () => { if(w.state === "redundant") resolve(); }));
  });
  await bundle(a, oldScript); await bundle(b, oldScript);
  assert.ok(requests.some(r => r.pathname === newScript));
  await context.setOffline(true); await a.reload(); await bundle(a, oldScript);
  assert.deepEqual(await snapshot(a), before);
  console.log("PASS failed real precache install retains offline old app");
  assert.equal(await a.evaluate(() => caches.has("awful-room-security-cutover-v2")), false,
    "failed precache must not create a pending or complete cutover marker");
  await context.setOffline(false); failAsset = false;
  const cutoverStarted = Date.now();
  await update(a);
  // The unmodified legacy app never consumes its 8 MB worklet warmup response.
  // Chromium retires that busy outgoing worker after its five-minute lame-duck
  // limit, even with skipWaiting set. Keep the real old bundle and allow that
  // bound; draining its response in the harness would mask the legacy defect.
  await Promise.all([a,b].map(p => bundle(p,newScript,370000)));
  await Promise.all([a,b].map(ready));
  assert.deepEqual(await snapshot(a), before);
  assert.equal(await a.evaluate(() => localStorage.getItem("bundled-cutover-sentinel")), "preserved");
  console.log(`PASS real old/new multi-tab forced cutover in ${Date.now() - cutoverStarted} ms; all non-telemetry IDB rows and localStorage unchanged`);
  await a.locator("#unlock-password").fill("bundled-cutover-password");
  await a.getByRole("button", { name: "Unlock", exact: true }).click();
  await a.locator("#unlock-password").waitFor({ state: "hidden" });
  await verifyUpgradedReadability(a, "upgraded app after original identity unlock");
  assert.deepEqual(await snapshot(a), before, "opening and downloading archive must not rewrite original records");
  const loads = await Promise.all([a,b].map(p => p.evaluate(() => sessionStorage.bundleLoads)));
  const registration = await a.evaluateHandle(() => navigator.serviceWorker.getRegistration());
  later = true; await update(a);
  // Use a synchronous predicate: Playwright 1.58 treats an async predicate's
  // Promise as truthy before its boolean result is available.
  await a.waitForFunction(r => r.waiting?.state === "installed", registration);
  assert.deepEqual(await Promise.all([a,b].map(p => p.evaluate(() => sessionStorage.bundleLoads))), loads);
  console.log("PASS subsequent ordinary deployment waits without forcing either tab");
  // Once accepted, the fixed current app must not hold its worker busy with
  // another unread warmup stream (the original bug would hit this timeout).
  const accepted = Date.now();
  await registration.evaluate(r => r.waiting.postMessage({ type: "SKIP_WAITING" }));
  await a.waitForFunction(r => !r.waiting && r.active?.state === "activated", registration);
  await registration.dispose();
  console.log(`PASS accepted subsequent update activates in ${Date.now() - accepted} ms`);
  await context.close(); await launch(); await context.setOffline(true);
  a = await context.newPage(); await a.goto(origin + "/app"); await ready(a); await bundle(a,newScript);
  await a.locator("#unlock-password").waitFor();
  assert.deepEqual(await snapshot(a), before);
  console.log("PASS cold offline current startup retains all original populated IDB rows before unlock");
  await a.locator("#unlock-password").fill("bundled-cutover-password");
  await a.getByRole("button", { name: "Unlock", exact: true }).click();
  await a.locator("#unlock-password").waitFor({ state: "hidden" });
  console.log("PASS new installed bundle cold offline startup and original identity unlock");
  await verifyUpgradedReadability(a, "cold offline upgraded app after original identity unlock");
  assert.deepEqual(await snapshot(a), before, "offline archive is read-only");
  assert.deepEqual(errors, [], "bundled application must not throw uncaught page errors");
  console.log("PASS no uncaught page errors");
  assert.deepEqual(readabilityFailures, [], "populated history must remain readable through the real upgraded UI");
} catch (e) {
  for (const p of context?.pages() || []) {
    console.error("FAIL PAGE", p.url(), await p.locator("body").innerText().catch(()=>"closed"));
    console.error("STATE", JSON.stringify(await p.evaluate(async () => ({ scripts:[...document.scripts].map(s=>s.src), registration: await navigator.serviceWorker.getRegistration().then(r=>r && ({active:r.active?.state,waiting:r.waiting?.state,installing:r.installing?.state})), caches: await Promise.all((await caches.keys()).map(async n=>({name:n,keys:(await (await caches.open(n)).keys()).map(r=>r.url).filter(u=>u.includes('cutover')||u.includes('index.html'))}))) })).catch(()=>null)));
  }
  throw e;
} finally {
  await context?.close(); await rm(profile,{recursive:true,force:true});
  tlsRelay.close();
  server.closeAllConnections(); await new Promise(r => server.close(r));
}
