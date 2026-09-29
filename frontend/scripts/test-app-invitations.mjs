// Real release-enabled dist, app-created identities, IndexedDB and Go relay.
// No app/module/storage/membership mocks. Protocol handler URL, not OS launch.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as createTlsServer } from 'node:tls';
import { connect as connectTcp } from 'node:net';
import { readFile } from 'node:fs/promises';
import { resolve, join, extname } from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dist = resolve(process.env.APP_DIST);
assert.ok(process.env.RELAY_MULTIADDR, 'RELAY_MULTIADDR required');
const traffic = [], errors = [];
// TLS terminator only: untouched libp2p/Noise traffic goes to the actual relay.
// Production's gater correctly rejects private/insecure websocket addresses.
const tlsRelay=createTlsServer({key:await readFile(process.env.RELAY_TLS_KEY),cert:await readFile(process.env.RELAY_TLS_CERT)},socket=>{
  const upstream=connectTcp(8080,'127.0.0.1');socket.pipe(upstream).pipe(socket);
  socket.on('error',()=>upstream.destroy());upstream.on('error',()=>socket.destroy());
});
await new Promise(r=>tlsRelay.listen(0,'127.0.0.1',r));
const relayAddr=`/dns4/relay.example.test/tcp/${tlsRelay.address().port}/wss/p2p/${process.env.RELAY_MULTIADDR.split('/').at(-1)}`;
const mime = {'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.svg':'image/svg+xml','.png':'image/png','.webmanifest':'application/manifest+json'};
const server = createServer(async (req,res) => {
  try {
    const chunks=[]; for await (const c of req) chunks.push(c);
    const body=Buffer.concat(chunks);
    traffic.push(JSON.stringify({url:req.url,headers:req.headers,body:body.toString()}));
    res.setHeader('Cache-Control','no-store');
    const pathname=new URL(req.url,'http://localhost').pathname;
    if(pathname==='/config.json') {res.setHeader('Content-Type','application/json');res.end(JSON.stringify({apiUrl:'/api',relayMultiaddr:relayAddr,sfuUrls:[],useQc:false,useQs:false}));return;}
    if(pathname.startsWith('/api/')) {
      const response=await fetch((process.env.RELAY_API || 'http://127.0.0.1:8081')+pathname.slice(4),{method:req.method,headers:{'content-type':req.headers['content-type']||'application/json'},...(body.length?{body}: {})});
      const text=await response.text();traffic.push(text);res.writeHead(response.status,{'content-type':response.headers.get('content-type')||'text/plain'});res.end(text);return;
    }
    let path=resolve(dist,'.'+pathname);
    assert.ok(path.startsWith(dist+'/'));
    if(!extname(path)) path=join(dist,'index.html');
    res.setHeader('Content-Type',mime[extname(path)]||'application/octet-stream');res.end(await readFile(path));
  }catch(e){res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`;
const browser=await chromium.launch({headless:true,args:['--no-sandbox','--ignore-certificate-errors','--host-resolver-rules=MAP relay.example.test 127.0.0.1']});
const password='app-invitation-browser-password';
async function page() {
  const context=await browser.newContext({viewport:{width:1440,height:1100},permissions:['clipboard-read','clipboard-write']});
  context.setDefaultTimeout(30000);
  context.on('request',r=>traffic.push(JSON.stringify({url:r.url(),headers:r.headers(),body:r.postData()})));
  const p=await context.newPage();p.on('pageerror',e=>errors.push(String(e)));
  p.on('websocket',ws=>{traffic.push(ws.url());ws.on('framesent',f=>traffic.push(Buffer.from(f.payload).toString()));ws.on('framereceived',f=>traffic.push(Buffer.from(f.payload).toString()));});
  if(process.env.TRACE_APP) p.on('console',m=>console.log('BROWSER',m.text()));
  await p.goto(origin+'/app');
  await p.getByRole('button',{name:'Got it',exact:true}).click();
  await p.getByRole('button',{name:'Create new identity',exact:true}).click();
  await p.locator('#create-password').fill(password);await p.locator('#create-password-confirm').fill(password);
  await p.getByRole('button',{name:'Create identity',exact:true}).click();
  await p.getByRole('checkbox',{name:/written down my recovery/}).check();
  await p.getByRole('button',{name:"I'm ready",exact:true}).click();
  await p.getByPlaceholder('Your display name').fill('App invitation tester');
  await p.getByRole('button',{name:'Done',exact:true}).click();
  if(await p.getByRole('button',{name:'Skip for now',exact:true}).isVisible()) await p.getByRole('button',{name:'Skip for now',exact:true}).click();
  return p;
}
async function unlock(p) {await p.locator('#unlock-password').fill(password);await p.getByRole('button',{name:'Unlock',exact:true}).click();await p.locator('#unlock-password').waitFor({state:'hidden'});}
async function rooms(p) {return p.evaluate(async()=>{
  const db=await new Promise((resolve,reject)=>{const r=indexedDB.open('awful-chat');r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});
  try{return await new Promise((resolve,reject)=>{const r=db.transaction('rooms').objectStore('rooms').getAll();r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error);});}finally{db.close();}
});}
async function chat(p) {await p.getByPlaceholder('Type a message...', {exact:true}).waitFor();await p.waitForURL(/\/r\/#(?!r2_).+/);}
try {
  const host=await page();
  await host.getByPlaceholder('Room name (optional)').fill('Bundled invitation room');
  await host.getByRole('button',{name:'Create room',exact:true}).click();
  const link=await host.getByLabel('Invitation link',{exact:true}).inputValue();
  const secret=new URL(link).hash.slice(1);assert.match(secret,/^r2_/);
  await host.getByRole('button',{name:'Join room',exact:true}).click();await chat(host);
  const storedURL=host.url(), id=new URL(storedURL).hash.slice(1);
  assert.notEqual(id,secret);assert.equal((await rooms(host)).length,1);
  console.log('PASS actual bundled UI creates identity and room; joins real relay',id);
  const guest=await page();await guest.goto(link);await guest.locator('#unlock-password').waitFor();
  assert.equal(new URL(guest.url()).hash,'','capability must be stripped before unlock');
  await unlock(guest);await chat(guest);assert.equal(guest.url(),storedURL);
  assert.equal((await rooms(guest)).length,1);
  console.log('PASS fragment entry stripped before unlock and imported through actual app/database');
  await guest.reload();await unlock(guest);await chat(guest);assert.equal(guest.url(),storedURL);
  assert.equal((await rooms(guest)).length,1);
   await guest.getByRole('button',{name:'Copy invite',exact:true}).click();
   await guest.getByRole('menuitem',{name:'Copy link',exact:true}).click();
   for(let attempt=0;attempt<100;attempt++) {
     if(await guest.evaluate(()=>navigator.clipboard.readText())===link) break;
     await new Promise(r=>setTimeout(r,50));
   }
  assert.equal(await guest.evaluate(()=>navigator.clipboard.readText()),link);
   console.log('PASS stored public-ID reload reopens and recovers original invitation via UI');
   assert.ok(!JSON.stringify(await rooms(guest)).includes(secret),'stored room must encrypt the capability at rest');
   // Same-document navigation exercises the mounted AppView, rather than a
   // fresh page whose initial parser could hide a missing hashchange handler.
   await guest.goto(origin+'/r/');await unlock(guest);
   await guest.evaluate(secret=>{location.hash=secret;},secret);
   await chat(guest);assert.equal(guest.url(),storedURL);
   assert.equal((await rooms(guest)).length,1);
   console.log('PASS unlocked same-document fragment import and encrypted room persistence');
   await guest.goto(origin+'/app');await guest.locator('#unlock-password').waitFor();
   await guest.goto(origin+'/r/');await guest.locator('#unlock-password').waitFor();
   await guest.evaluate(secret=>{location.hash=secret;},secret);
   await guest.waitForURL(origin+'/r/');
   await unlock(guest);await chat(guest);assert.equal(guest.url(),storedURL);
   console.log('PASS locked same-document fragment is stripped and retained until unlock');
  const protocol=await page();
  const manifest=JSON.parse(await readFile(join(dist,'manifest.webmanifest'),'utf8'));
  const handler=manifest.protocol_handlers.find(h=>h.protocol==='web+awfl').url;
  await protocol.goto(new URL(handler.replace('%s',encodeURIComponent(`web+awfl://r/#${secret}`)),origin).href);
  await protocol.locator('#unlock-password').waitFor();assert.equal(new URL(protocol.url()).hash,'');
  await unlock(protocol);await chat(protocol);assert.equal(protocol.url(),storedURL);
  console.log('PASS manifest protocol-handler URL navigation (not native OS launch)');
   await protocol.goto(origin+'/app');await protocol.locator('#unlock-password').waitFor();
   await protocol.goto(origin+'/r/#r2_malformed');await protocol.locator('#unlock-password').waitFor();
  assert.equal(new URL(protocol.url()).hash,'');await unlock(protocol);
   await protocol.getByRole('alert').filter({hasText:/Invalid|secret/i}).waitFor();assert.equal((await rooms(protocol)).length,1);
  assert.equal(await protocol.getByPlaceholder('Type a message...',{exact:true}).count(),0);
  console.log('PASS malformed invitation fails without membership/database insertion');
  for(const text of traffic) assert.ok(!text.includes(secret),'capability leaked in HTTP/WS traffic');
  assert.deepEqual(errors,[]);
  console.log(`PASS ${traffic.length} HTTP/WS observations contain no plaintext capability; no uncaught page errors`);
} catch(e) {
  for(const c of browser.contexts()) for(const p of c.pages()) console.error('FAIL PAGE',p.url(),await p.locator('body').innerText());
  throw e;
} finally {await browser.close();tlsRelay.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
