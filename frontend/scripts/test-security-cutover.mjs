// Real Chromium worker lifecycle test using the production cutover helper.
// PLAYWRIGHT_MODULE may point at an isolated Playwright installation.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const ts = require("typescript");
const helper = ts.transpileModule(await readFile(new URL(
  "../src/lib/room-security/pwa-cutover.ts", import.meta.url), "utf8"), {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ES2022 },
}).outputText.replaceAll("export ", "");
let version = 1;
let failInstall = false;
const server = createServer((req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.url === "/sw.js") {
    res.setHeader("Content-Type", "application/javascript");
    res.end(`${helper}
      const VERSION = ${version};
      self.addEventListener('install', e => e.waitUntil((async () => {
        if (${failInstall}) throw new Error('simulated precache failure');
        const c = await caches.open('fixture-' + VERSION);
        await c.add('/');
      })()));
      if (VERSION === 1) self.addEventListener('install', e => e.waitUntil(self.skipWaiting()));
      if (VERSION >= 2) {
        self.addEventListener('install', e => e.waitUntil(installSecurityCutover(
          caches, !!self.registration.active, () => self.skipWaiting())));
        self.addEventListener('activate', e => e.waitUntil(activateSecurityCutover(caches, async () => {
          const windows = await self.clients.matchAll({type:'window', includeUncontrolled:true});
          await navigateSecurityCutoverWindows(windows);
        })));
      }
      self.addEventListener('activate', e => e.waitUntil(self.clients.claim()));
      self.addEventListener('fetch', e => {
        if (e.request.mode === 'navigate') e.respondWith(
          caches.open('fixture-' + VERSION).then(c => c.match('/')));
      });
    `);
  } else {
    res.setHeader("Content-Type", "text/html");
    res.end(`<body data-version="${version}"><script>
      sessionStorage.loads = String(Number(sessionStorage.loads || 0) + 1);
      navigator.serviceWorker.register('/sw.js');
    </script></body>`);
  }
});
await new Promise(resolve => server.listen(0, "0.0.0.0", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true, args: ["--no-sandbox"] });
async function ready(page) {
  await page.evaluate(() => navigator.serviceWorker.ready.then(() => undefined));
  await page.waitForFunction(() => navigator.serviceWorker.controller !== null);
}
async function update(page) {
  // Activation intentionally navigates this page, so don't await a promise in
  // a realm that the worker is about to destroy.
  await page.evaluate(() => { void navigator.serviceWorker.getRegistration().then(r => r.update()); });
}
async function waiting(page) {
  await page.waitForFunction(async () => !!(await navigator.serviceWorker.getRegistration()).waiting);
}
try {
  const context = await browser.newContext();
  const a = await context.newPage();
  const b = await context.newPage();
  await a.goto(origin); await ready(a);
  await b.goto(origin); await ready(b);
  await a.evaluate(() => localStorage.setItem("legacy-history", "preserved"));
  await context.setOffline(true);
  await a.reload();
  assert.equal(await a.locator("body").getAttribute("data-version"), "1");
  await context.setOffline(false);
  version = 2;
  failInstall = true;
  await a.evaluate(async () => {
    const r = await navigator.serviceWorker.getRegistration();
    await r.update();
    const worker = r.installing;
    if (worker && worker.state !== "redundant") await new Promise(resolve => {
      worker.addEventListener("statechange", () => { if (worker.state === "redundant") resolve(); });
    });
  });
  assert.equal(await a.locator("body").getAttribute("data-version"), "1");
  failInstall = false;
  await update(a);
  await Promise.all([a, b].map(p => p.waitForFunction(() => document.body.dataset.version === "2")));
  assert.equal(await a.evaluate(() => localStorage.getItem("legacy-history")), "preserved");
  const loads = await Promise.all([a, b].map(p => p.evaluate(() => sessionStorage.loads)));
  version = 3;
  await update(a); await waiting(a);
  assert.deepEqual(await Promise.all([a, b].map(p => p.evaluate(() => sessionStorage.loads))), loads);
  assert.equal(await b.locator("body").getAttribute("data-version"), "2");
  await context.close();
  console.log("PASS: offline legacy startup, failed install, two-tab forced cutover, local data preservation, later update waits");

  version = 2;
  const fresh = await browser.newContext();
  const page = await fresh.newPage();
  await page.goto(origin); await ready(page);
  assert.equal(await page.evaluate(() => sessionStorage.loads), "1");
  version = 3;
  await update(page); await waiting(page);
  assert.equal(await page.evaluate(() => sessionStorage.loads), "1");
  await fresh.close();
  console.log("PASS: fresh v2 install does not reload; subsequent update waits");
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
