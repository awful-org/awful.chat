// Chromium production-client / real-relay integration. Start the relay separately.
// Isolated Playwright installation via PLAYWRIGHT_MODULE; no repository dependency.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { build } = require(process.env.ESBUILD_MODULE || "esbuild");
const relay = process.env.PAIRING_RELAY_URL || "http://127.0.0.1:8081";
const result = await build({
  stdin: { contents: `import * as pairing from './src/lib/invite-pairing';
    import {newRoomSecret} from './src/lib/room-security/keys';
    window.pairing = pairing; window.newRoomSecret = newRoomSecret;`,
    resolveDir: fileURLToPath(new URL("../", import.meta.url)), loader: "ts" },
  bundle: true, write: false, platform: "browser", format: "esm",
  define: { "import.meta.env.DEV": "false" },
});
const traffic = [];
const server = createServer(async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.url === "/client.js") {
    res.setHeader("Content-Type", "application/javascript");
    return res.end(result.outputFiles[0].text);
  }
  if (req.url === "/invite") {
    try {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = Buffer.concat(chunks).toString();
      const response = await fetch(`${relay}/invite`, { method: "POST",
        headers: { "content-type": "application/json" }, body });
      const text = await response.text();
      traffic.push({ body, text, status: response.status });
      res.writeHead(response.status, { "content-type": "application/json" });
      return res.end(text);
    } catch (error) { res.writeHead(502); return res.end(String(error)); }
  }
  res.setHeader("Content-Type", "text/html");
  res.end('<!doctype html><script type="module" src="/client.js"></script>');
});
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
try {
  const inviter = await browser.newPage();
  const joiner = await browser.newPage();
  for (const page of [inviter, joiner]) {
    await page.goto(origin);
    await page.waitForFunction(() => !!window.pairing);
  }
  async function host() {
    return inviter.evaluate(async () => {
      window.host?.cancel();
      window.secret = window.newRoomSecret();
      window.host = await window.pairing.hostInvitationPairing(window.secret, s => window.statusText = s);
      return { secret: window.secret, code: window.host.code };
    });
  }
  async function join(code) {
    return joiner.evaluate(async code => {
      try { return { secret: await window.pairing.joinInvitationPairing(code, AbortSignal.timeout(15000)) }; }
      catch (error) { return { error: String(error) }; }
    }, code);
  }
  const first = await host();
  assert.deepEqual(await join(first.code), { secret: first.secret });
  await inviter.waitForFunction(() => window.statusText?.includes("delivered"));
  assert.ok((await join(first.code)).error, "used invitation must reject another join");
  const second = await host();
  const wrong = second.code.slice(0, -1) + (second.code.endsWith("0") ? "1" : "0");
  assert.ok((await join(wrong)).error, "wrong password must fail");
  assert.deepEqual(await join(second.code), { secret: second.secret }, "one wrong attempt must not destroy pairing");
  const third = await host();
  const cancelled = inviter.waitForResponse(r => r.url().endsWith('/invite') && r.request().postDataJSON()?.action === 'cancel');
  await inviter.evaluate(() => window.host.cancel());
  // The host's cancellation request is asynchronous. Wait for its relay response.
  await cancelled;
  assert.ok((await join(third.code)).error, "cancelled invitation must reject joining");
  const fourth = await host();
  const wrongAgain = fourth.code.slice(0, -1) + (fourth.code.endsWith("0") ? "1" : "0");
  for (let attempt = 0; attempt < 5; attempt++) {
    assert.ok((await join(wrongAgain)).error, "each wrong-password attempt must fail");
  }
  assert.ok((await join(fourth.code)).error, "exhausted invitation must reject even the correct password");
  for (const item of [first, second, third, fourth]) {
    const password = item.code.replace(/[-\s]/g, "").slice(8);
    for (const exchange of traffic) {
      assert.ok(!exchange.body.includes(item.secret) && !exchange.text.includes(item.secret), "room secret exposed at relay");
      assert.ok(!exchange.body.includes(password) && !exchange.text.includes(password), "pairing password exposed at relay");
    }
  }
  assert.ok(traffic.every(t => t.status !== 502), "relay must be reachable");
  console.log(`PASS: real relay + two Chromium clients: transfer, reuse, wrong password/recovery, cancellation, attempt exhaustion; ${traffic.length} exchanges checked for secrets`);
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}
