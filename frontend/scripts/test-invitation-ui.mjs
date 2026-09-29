// Actual Svelte invitation components + production OPAQUE client + real Go relay.
// Profile/storage/transport-shell dependencies are fixtures; onJoin is captured,
// not a complete AppView import/chat test. Native share is a simulated API boundary.
// Only the isolated source copy's release gate is enabled; shared source is untouched.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, readFile, writeFile, symlink, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const { build } = await import(pathToFileURL(require.resolve("vite")));
const { svelte } = await import(pathToFileURL(require.resolve("@sveltejs/vite-plugin-svelte")));
const QRCode = require("qrcode");
const relay = process.env.PAIRING_RELAY_URL;
assert.ok(relay, "Set PAIRING_RELAY_URL to a running real Go relay API");
await mkdir("/tmp/opencode", { recursive: true });
const temp = await mkdtemp("/tmp/opencode/invitation-ui-");
let browser, server;
const traffic = [], errors = [], requests = [];
try {
  await cp(join(root, "src"), join(temp, "src"), { recursive: true });
  await symlink(join(root, "node_modules"), join(temp, "node_modules"));
  await writeFile(join(temp, "package.json"), '{"type":"module"}');
  const gate = join(temp, "src/lib/room-security/invitation-release.ts");
  const originalGate = await readFile(gate, "utf8");
  assert.match(originalGate, /ROOM_SECURITY_V2_RELEASED: boolean = (true|false)/);
  await writeFile(gate, originalGate.replace("boolean = false", "boolean = true"));
  const fixtures = {
    "$lib/profile.svelte": `export const profileStore = $state({nickname:'UI Tester',avatarUrl:null}); export async function loadProfile(){} export async function saveName(name){profileStore.nickname=name;}`,
    "$lib/transport/transport.svelte": `export const transportState = {relayConnected:true};`,
    "$lib/media-prefs.svelte": `export const mediaPrefs = {gifAutoplay:false}; export function canLoadMedia(){return true;}`,
    "$lib/display-prefs.svelte": `export const displayPrefs = {};`,
    "$lib/storage": `export async function getRoom(code){return window.testRooms?.[code];} export async function putRoom(room){window.testRooms ??= {};window.testRooms[room.roomCode]=room;}`,
    "$lib/components/AvatarPickerDialog.svelte": `<script>let {open,onClose}=$props();</script>`,
  };
  const alias = [];
  let count = 0;
  for (const [find, contents] of Object.entries(fixtures)) {
    const replacement = join(temp, `fixture-${count++}${find.endsWith('.svelte') && find.includes('components') ? '.svelte' : '.svelte.js'}`);
    await writeFile(replacement, contents);
    alias.push({ find, replacement });
  }
  alias.push({ find: "$lib", replacement: join(temp, "src/lib") });
  await writeFile(join(temp, "Fixture.svelte"), `<script>
    import RoomCreateJoin from './src/lib/components/RoomCreateJoin.svelte';
    import InvitationDialog from './src/lib/components/InvitationDialog.svelte';
    let open = $state(false); let roomCode = $state(''); let shown = $state(true);
    window.showDialog = code => {roomCode=code;open=true;};
    window.hideView = () => shown=false;
    window.joined = []; window.joinFailure = false;
    async function joined(...args){if(window.joinFailure) throw new Error('Fixture join failed');window.joined.push(args);}
  </script>
  {#if shown}<RoomCreateJoin onJoin={joined}/>{/if}
  <InvitationDialog {roomCode} bind:open/>
  `);
  await writeFile(join(temp, "entry.js"), `import {mount} from 'svelte';
    import Fixture from './Fixture.svelte';
    import {deriveRoomKeys,newRoomSecret} from './src/lib/room-security/keys';
    import {parseJoinInput} from './src/lib/invite';
    window.newRoomSecret=newRoomSecret;window.deriveRoomKeys=deriveRoomKeys;window.parseJoinInput=parseJoinInput;
    mount(Fixture,{target:document.body});window.ready=true;`);
  await writeFile(join(temp, "index.html"), '<!doctype html><meta charset="utf-8"><style>button,input{margin:6px;padding:6px} [role=dialog]{position:fixed;inset:10px;background:white;overflow:auto;z-index:100} [data-slot=dialog-overlay]{position:fixed;inset:0;background:#8888} svg{width:20px;height:20px}</style><script type="module" src="/entry.js"></script>');
  await build({ root: temp, configFile: false, plugins: [svelte()], resolve: { alias },
    build: { outDir: join(temp, "dist"), minify: false }, logLevel: "warn" });
  server = createServer(async (req, res) => {
    requests.push(req.url);
    res.setHeader("Cache-Control", "no-store");
    if (req.url === "/invite") {
      try {
        const chunks = []; for await (const chunk of req) chunks.push(chunk);
        const body = Buffer.concat(chunks).toString();
        const response = await fetch(`${relay}/invite`, { method: "POST", headers: { "content-type": "application/json" }, body });
        const text = await response.text(); traffic.push({ body, text, status: response.status });
        res.writeHead(response.status, { "content-type": "application/json" });res.end(text);
      } catch (error) { res.writeHead(502);res.end(String(error)); }
      return;
    }
    const path = req.url.startsWith('/assets/') ? req.url : '/index.html';
    try { res.setHeader('Content-Type', path.endsWith('.js') ? 'application/javascript' : 'text/html');res.end(await readFile(join(temp,'dist',path))); }
    catch { res.writeHead(404);res.end(); }
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  browser = await chromium.launch({ headless: true });
  async function page() {
    const context = await browser.newContext({ permissions: ['clipboard-read','clipboard-write'] });
    await context.addInitScript(() => {
      window.shares=[];window.shareMode='success';
      Object.defineProperty(navigator,'share',{configurable:true,value:async data=>{
        window.shares.push(data);if(window.shareMode!=='success') throw new DOMException('Fixture share failure',window.shareMode);
      }});
    });
    const p = await context.newPage();p.on('pageerror', e=>errors.push(String(e)));
    await p.goto(origin);await p.waitForFunction(()=>window.ready);return p;
  }
  const host = await page(), guest = await page();
  const clipboard = p => p.evaluate(()=>navigator.clipboard.readText());
  async function press(p, name) {await p.getByRole('button',{name,exact:true}).click();}
  async function getShortLink(p) {await press(p,'Get a short code');await press(p,'Copy short link');}
  async function qr(p, link) {
    const image = p.getByRole('img',{name:'Room invitation QR code'});
    await image.waitFor();
    const expected = await QRCode.toDataURL(link,{width:280,margin:2});
    assert.ok(await image.evaluate(async (img, expected) => {
      await img.decode(); const other = new Image();other.src=expected;await other.decode();
      const pixels = source => {const canvas=document.createElement('canvas');canvas.width=canvas.height=280;const ctx=canvas.getContext('2d');ctx.drawImage(source,0,0);return ctx.getImageData(0,0,280,280).data;};
      const a=pixels(img),b=pixels(other);return a.every((value,i)=>value===b[i]);
    },expected), 'QR pixels must encode the complete displayed link');
    assert.ok(await image.evaluate(img=>img.complete && img.naturalWidth===280),'QR must render');
  }
  async function submit(p, input) {await p.getByLabel('Room link or code',{exact:true}).fill(input);await p.getByRole('button',{name:'Join room',exact:true}).click();}
  async function joined(p, expected, count=1) {await p.waitForFunction(n=>window.joined.length===n,count);assert.equal(await p.evaluate(()=>window.joined.at(-1)[0]),expected);}
  await host.getByLabel('Room name',{exact:false}).fill('Browser room');
  await host.getByRole('button',{name:'Create room',exact:true}).click();
  const link = await host.getByLabel('Invitation link',{exact:true}).inputValue();
  const secret = new URL(link).hash.slice(1);assert.match(secret,/^r2_/);
  assert.equal(await host.getByRole('img',{name:'Room invitation QR code'}).count(),0,'QR folded by default');
  await press(host,'Show QR code');await qr(host,link);await press(host,'Copy invitation link');assert.equal(await clipboard(host),link);
  await press(host,'Share invite link');assert.deepEqual(await host.evaluate(()=>window.shares),[{url:link}]);
  await host.evaluate(()=>{window.shareMode='AbortError';return navigator.clipboard.writeText('sentinel');});
  await press(host,'Share invite link');assert.equal(await clipboard(host),'sentinel','share cancellation must not copy');
  await host.evaluate(()=>window.shareMode='NotAllowedError');await press(host,'Share invite link');assert.equal(await clipboard(host),link,'failed share falls back to clipboard');
  await submit(guest,'retired-code');await guest.getByRole('alert').filter({hasText:'Enter a valid'}).waitFor();
  assert.deepEqual(await guest.evaluate(()=>window.joined),[]);
  await submit(guest,link);await joined(guest,secret);
  await submit(guest,`web+awfl://${secret}`);await joined(guest,secret,2);
  await submit(guest,`${origin}/r/#${encodeURIComponent(`web+awfl://r/#${secret}`)}`);await joined(guest,secret,3);
  const id = await host.evaluate(secret=>window.deriveRoomKeys(secret).discoveryId,secret);
  await submit(guest,id);await guest.getByRole('alert').filter({hasText:'Enter a valid'}).waitFor();
  await guest.evaluate(link=>navigator.clipboard.writeText(link),link);await guest.getByRole('button',{name:'Paste room code'}).click();await guest.waitForFunction(link=>document.querySelector('#join-code').value===link,link);
  const shortLink = new RegExp(`^${origin.replace(/[.]/g,'\\.')}/r/#[0-9a-z]{3}-[0-9a-z]{3}$`);
  await getShortLink(host);
  await host.getByRole('button',{name:'Cancel short code',exact:true}).waitFor();
  const pairingCode = await clipboard(host);assert.match(pairingCode,shortLink);
  await submit(guest,pairingCode);await joined(guest,secret,4);
  await host.getByText('Invitation delivered. This code is now used.',{exact:true}).waitFor();
  await submit(guest,pairingCode);await guest.getByRole('alert').waitFor();assert.equal(await guest.evaluate(()=>window.joined.length),4);
  // Joining the room ends the view, not a short link handed out from it.
  await getShortLink(host);await host.getByRole('button',{name:'Cancel short code',exact:true}).waitFor();
  const lateCode = await clipboard(host);assert.notEqual(lateCode,pairingCode);
  await host.getByRole('button',{name:'Join room',exact:true}).click();await joined(host,secret);assert.equal(await host.evaluate(()=>window.joined[0][2]),'Browser room');
  await submit(guest,lateCode);await joined(guest,secret,5);
  console.log('PASS: RoomCreateJoin create/QR/copy/share/cancel/fallback, invalid/public-ID rejection, paste, full/protocol links, real-relay UI pairing by short link, reuse rejection, created-room callback, short link outliving the view');

  await host.evaluate(({id,secret})=>{window.testRooms={[id]:{roomCode:id,roomSecret:secret}};window.showDialog(id);},{id,secret});
  const dialog=host.getByRole('dialog');await dialog.waitFor();
  assert.equal(await dialog.getByLabel('Invitation link',{exact:true}).inputValue(),link);await qr(dialog,link);
  await dialog.getByRole('button',{name:'Copy invitation link',exact:true}).click();assert.equal(await clipboard(host),link);
  await host.evaluate(()=>window.shareMode='success');await dialog.getByRole('button',{name:'Share invite link',exact:true}).click();assert.equal(await host.evaluate(()=>window.shares.at(-1).url),link);
  // Closing the dialog leaves the code working; reopening tells how it ended.
  await dialog.getByRole('button',{name:"Can't scan? Get a short code",exact:true}).click();await dialog.getByRole('button',{name:'Copy short link',exact:true}).click();
  const dialogCode=await clipboard(host);assert.match(dialogCode,shortLink);
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  await submit(guest,dialogCode);await joined(guest,secret,6);
  await host.evaluate(id=>window.showDialog(id),id);
  await dialog.getByRole('status').filter({hasText:'Invitation delivered'}).waitFor();assert.equal(await dialog.getByRole('button',{name:'Copy short link',exact:true}).count(),0);
  // A live code shows again on reopen, and its own Cancel ends it.
  await dialog.getByRole('button',{name:"Can't scan? Get a short code",exact:true}).click();await dialog.getByRole('button',{name:'Copy short link',exact:true}).click();
  const cancelledCode=await clipboard(host);
  await dialog.getByRole('button',{name:'Close',exact:true}).click();await host.evaluate(id=>window.showDialog(id),id);
  await dialog.getByRole('button',{name:'Copy short link',exact:true}).click();assert.equal(await clipboard(host),cancelledCode);
  const cancellation=host.waitForResponse(r=>r.url().endsWith('/invite')&&r.request().postDataJSON()?.action==='cancel');
  await dialog.getByRole('button',{name:'Cancel short code',exact:true}).click();await cancellation;
  assert.equal(await dialog.getByRole('button',{name:'Copy short link',exact:true}).count(),0);
  await submit(guest,cancelledCode);await guest.getByRole('alert').waitFor();assert.equal(await guest.evaluate(()=>window.joined.length),6);
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  console.log('PASS: InvitationDialog saved-room/QR/copy/share, real-relay UI transfer by short link, code outliving the dialog, delivered status on reopen, explicit cancellation');

  // A clipboard permission prompt can outlive its dialog. Its completion must not
  // overwrite status in a newly opened dialog.
  await host.evaluate(id=>window.showDialog(id),id);await dialog.getByLabel('Invitation link',{exact:true}).waitFor();
  await host.evaluate(()=>{window.originalWrite=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=()=>new Promise(resolve=>window.finishCopy=resolve);});
  await dialog.getByRole('button',{name:'Copy invitation link',exact:true}).click();
  await host.waitForFunction(()=>!!window.finishCopy);
  await dialog.getByRole('button',{name:'Close',exact:true}).click();
  await host.evaluate(id=>window.showDialog(id),id);await dialog.getByLabel('Invitation link',{exact:true}).waitFor();
  await host.evaluate(()=>{window.finishCopy();navigator.clipboard.writeText=window.originalWrite;});
  assert.equal(await dialog.getByRole('status').textContent(),'','stale clipboard completion overwrote replacement dialog');
  await dialog.getByRole('button',{name:'Close',exact:true}).click();

  // Editing a pairing input aborts the old request. Its rejection must not mark
  // the replacement full invitation invalid or display a stale abort error.
  const editing=await page();let releaseStart;const startHeld=new Promise(resolve=>releaseStart=resolve);
  let sawStart;const started=new Promise(resolve=>sawStart=resolve);
  await editing.route('**/invite',async route=>{if(route.request().postDataJSON()?.action==='start'){sawStart();await startHeld;}await route.continue().catch(()=>{});});
  await submit(editing,dialogCode);await started;
  await editing.getByLabel('Room link or code',{exact:true}).fill(link);
  releaseStart();await editing.getByRole('button',{name:'Join room',exact:true}).waitFor();
  assert.equal(await editing.getByRole('alert').count(),0,'aborted old join error leaked into replacement input');
  await editing.getByRole('button',{name:'Join room',exact:true}).click();await joined(editing,secret);
  console.log('PASS: stale clipboard completion and edited-input cancellation isolation');
  for(const exchange of traffic) {
    assert.ok(!exchange.body.includes(secret)&&!exchange.text.includes(secret),'secret exposed at relay');
    // The whole code, locator and password together: the locator is sent on
    // purpose, and four characters alone turn up by chance in base64 payloads.
    for(const link of [pairingCode,lateCode,dialogCode,cancelledCode]) {
      const code=link.split('#').pop();
      assert.match(code,/^[0-9a-z]{3}-[0-9a-z]{3}$/);
      for(const form of [code,code.replace('-','')]) assert.ok(!exchange.body.includes(form)&&!exchange.text.includes(form),'pairing code exposed at relay');
    }
  }
  assert.ok(traffic.length>0&&traffic.every(t=>t.status!==502));
  assert.ok(requests.every(url=>!url.includes(secret)),'secret in HTTP URL');
  assert.deepEqual(errors,[],'unexpected browser exceptions');
  assert.equal(await readFile(join(root,'src/lib/room-security/invitation-release.ts'),'utf8'),originalGate,'shared gate changed');
  console.log(`PASS: ${traffic.length} real relay exchanges inspected; shared gate unchanged; no browser exceptions`);
} finally {
  await browser?.close();
  if(server) await new Promise(resolve=>server.close(resolve));
  await rm(temp,{recursive:true,force:true});
}
