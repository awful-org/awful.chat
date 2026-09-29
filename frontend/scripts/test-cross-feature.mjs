// Actual built app UI + real Go relay. No application imports or signaling bridge.
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createServer as tls } from 'node:tls';
import { connect } from 'node:net';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import { createRequire } from 'node:module';
const { chromium } = createRequire(import.meta.url)(process.env.PLAYWRIGHT_MODULE || 'playwright');
const dist = resolve(process.env.APP_DIST);
const errors = [], traffic = [], browsers = [];
const relay = tls({key:await readFile(process.env.RELAY_TLS_KEY),cert:await readFile(process.env.RELAY_TLS_CERT)}, s => {
  const upstream=connect(Number(process.env.RELAY_PORT || 18080),'127.0.0.1');s.pipe(upstream).pipe(s);
  s.on('error',()=>upstream.destroy());upstream.on('error',()=>s.destroy());
});
await new Promise(r=>relay.listen(0,'127.0.0.1',r));
const relayMultiaddr=`/dns4/relay.example.test/tcp/${relay.address().port}/wss/p2p/${process.env.RELAY_MULTIADDR.split('/').at(-1)}`;
const server=createServer(async(req,res)=>{
  try {
    const url=new URL(req.url,'http://localhost');
    res.setHeader('Cache-Control','no-store');
    if(url.pathname==='/config.json'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({apiUrl:'/api',relayMultiaddr,sfuUrls:process.env.SFU_URL?[process.env.SFU_URL]:[],useQc:true,useQs:true}));return;}
    if(url.pathname.startsWith('/api/')){
      const chunks=[];for await(const c of req)chunks.push(c);const body=Buffer.concat(chunks);
      const response=await fetch((process.env.RELAY_API || 'http://127.0.0.1:18081')+url.pathname.slice(4)+url.search,{method:req.method,headers:{'content-type':req.headers['content-type']||'application/json'},...(body.length?{body}:{})});
      res.writeHead(response.status,{'content-type':response.headers.get('content-type')||'text/plain'});res.end(await response.text());return;
    }
    const file=resolve(dist,'.'+(extname(url.pathname)?url.pathname:'/index.html'));assert.ok(file.startsWith(dist+'/'));
    res.setHeader('Content-Type',({'.html':'text/html','.js':'application/javascript','.css':'text/css','.json':'application/json','.wasm':'application/wasm','.svg':'image/svg+xml','.webmanifest':'application/manifest+json'})[extname(file)]||'application/octet-stream');res.end(await readFile(file));
  }catch {res.writeHead(404);res.end();}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const origin=`http://127.0.0.1:${server.address().port}`,password='cross-feature-test-password';
async function actor(name){
  const b=await chromium.launch({headless:true,args:['--no-sandbox','--ignore-certificate-errors','--host-resolver-rules=MAP relay.example.test 127.0.0.1','--use-fake-device-for-media-stream','--use-fake-ui-for-media-stream']});browsers.push(b);
  const c=await b.newContext({viewport:{width:1440,height:1100},permissions:['clipboard-read','clipboard-write'],acceptDownloads:true});c.setDefaultTimeout(60000);
  const p=await c.newPage();p.on('pageerror',e=>errors.push(String(e)));p.on('console',m=>{if(m.text().includes('dropped undecryptable'))errors.push(m.text());if(process.env.TRACE_APP)console.log(name,m.text());});
  p.on('websocket',ws=>{ws.on('framesent',f=>traffic.push(Buffer.from(f.payload).toString()));ws.on('framereceived',f=>traffic.push(Buffer.from(f.payload).toString()));});
  await p.goto(origin+'/app');await p.getByRole('button',{name:'Got it',exact:true}).click();await p.getByRole('button',{name:'Create new identity',exact:true}).click();
  await p.locator('#create-password').fill(password);await p.locator('#create-password-confirm').fill(password);await p.getByRole('button',{name:'Create identity',exact:true}).click();
  await p.getByRole('checkbox',{name:/written down my recovery/}).check();await p.getByRole('button',{name:"I'm ready",exact:true}).click();await p.getByPlaceholder('Your display name').fill(name);await p.getByRole('button',{name:'Done',exact:true}).click();
  if(await p.getByRole('button',{name:'Skip for now',exact:true}).isVisible())await p.getByRole('button',{name:'Skip for now',exact:true}).click();return p;
}
async function unlock(p){await p.locator('#unlock-password').fill(password);await p.getByRole('button',{name:'Unlock',exact:true}).click();}
async function chat(p){await p.getByPlaceholder('Type a message...',{exact:true}).waitFor();}
async function send(p,text){await p.getByPlaceholder('Type a message...',{exact:true}).fill(text);await p.getByRole('button',{name:'Send message',exact:true}).click();}
async function seen(p,text){await p.getByText(text,{exact:true}).first().waitFor();}
async function fetchFile(p,name,bytes){
  await seen(p,name);const link=p.locator(`a[download="${name}"]`);
  if(!await link.isVisible()){
    // Local hydration can replace the request button while Playwright waits
    // for layout stability. A ready authenticated download is the other outcome.
    await p.getByRole('button',{name:'Download file',exact:true}).click({timeout:3000}).catch(async e=>{if(!await link.isVisible())throw e;});
  }
  await link.waitFor();const pending=p.waitForEvent('download');await link.click();const file=await pending;assert.deepEqual(await readFile(await file.path()),bytes);
}
async function openDm(p,name){await p.getByRole('button',{name:/^DMs(?: \d+)?$/}).click();await p.getByText(name,{exact:true}).first().click();await chat(p);}
async function settings(p,tab){await p.getByRole('button',{name:'Settings',exact:true}).click();await p.getByRole('button',{name:tab,exact:true}).click();}
try{
 if(process.env.QUICK){
  const a=await actor('Quick Alice'),b=await actor('Quick Bob');
  const bytes=Buffer.from('Cross feature protected quick-send exact bytes '.repeat(4000));
  await a.goto(origin+'/qs');await seen(a,'Protected file link');const link=a.url();assert.match(new URL(link).hash,/^#r2_/);
  await a.getByRole('checkbox').check();await a.locator('input[type=file]').setInputFiles({name:'quick-cross.bin',mimeType:'application/octet-stream',buffer:bytes});
  await b.goto(link);await seen(b,'quick-cross.bin');await b.getByRole('button',{name:'Accept',exact:true}).click();await b.locator('a[download="quick-cross.bin"]').waitFor();const pending=b.waitForEvent('download');await b.locator('a[download="quick-cross.bin"]').click();assert.deepEqual(await readFile(await (await pending).path()),bytes);await seen(a,'Delivered · this link is closed.');console.log('PASS quick-send actual app protected signaling, authenticated exact bytes and one-time host closure');
  await a.goto(origin+'/qc');await writeFile(process.env.EVIDENCE_DIR+'/quick-call-start.txt',await a.locator('body').innerText());
  await a.getByRole('button',{name:'Join as a guest',exact:true}).click();await a.getByPlaceholder('Your display name').fill('Quick caller Alice');await a.getByRole('button',{name:'Join call',exact:true}).click();await a.getByRole('button',{name:'Leave call',exact:true}).first().waitFor();
  const callLink=a.url();await b.goto(callLink);await b.getByRole('button',{name:'Join as a guest',exact:true}).click();await b.getByPlaceholder('Your display name').fill('Quick caller Bob');await b.getByRole('button',{name:'Join call',exact:true}).click();await b.getByRole('button',{name:'Leave call',exact:true}).first().waitFor();await seen(a,'Quick caller Bob');await seen(b,'Quick caller Alice');
  await writeFile(process.env.EVIDENCE_DIR+'/quick-call-connected.txt',await a.locator('body').innerText());
  await a.getByRole('button',{name:'Mute microphone',exact:true}).first().click();await a.getByRole('button',{name:'Unmute microphone',exact:true}).first().click();
  if(process.env.SFU_URL){
    await a.getByRole('button',{name:'Turn on camera',exact:true}).first().click();
    await a.getByRole('button',{name:'Start camera',exact:true}).click();
    await b.waitForFunction(()=>[...document.querySelectorAll('video')].some(v=>!v.classList.contains('-scale-x-100') && v.srcObject instanceof MediaStream && v.srcObject.getVideoTracks().some(t=>t.readyState==='live') && v.videoWidth>0));
    await a.getByRole('button',{name:'Turn off camera',exact:true}).first().click();console.log('PASS quick-call SFU remote synthetic camera track and decoded video frames');
  }
  await b.getByRole('button',{name:'Leave call',exact:true}).first().click();await a.getByRole('button',{name:'Leave call',exact:true}).first().click();console.log('PASS quick-call guest join, peer presence, mute/unmute and leave with synthetic media');assert.deepEqual(errors,[]);
 }else{
  const a=await actor('Cross Alice');await a.getByPlaceholder('Room name (optional)').fill('Cross feature room');await a.getByRole('button',{name:'Create room',exact:true}).click();
  const link=await a.getByLabel('Invitation link',{exact:true}).inputValue();await a.getByRole('button',{name:'Join room',exact:true}).click();await chat(a);
  const b=await actor('Cross Bob');await b.goto(link);await unlock(b);await chat(b);
  await send(a,'cross room live Alice');await seen(b,'cross room live Alice');await send(b,'cross room live Bob');await seen(a,'cross room live Bob');
  console.log('PASS independent Chromium processes: UI identity/create/join and bidirectional real-relay room chat');
  await b.reload();await unlock(b);await chat(b);await seen(b,'cross room live Alice');
  await send(a,'cross room reconnect');await seen(b,'cross room reconnect');console.log('PASS room persisted history and reload/unlock/reconnect live delivery');
  const bytes=Buffer.alloc(128*1024+123);for(let i=0;i<bytes.length;i++)bytes[i]=(i*31+7)%256;
  await a.locator('input[type=file]').first().setInputFiles({name:'cross-authenticated.bin',mimeType:'application/octet-stream',buffer:bytes});await a.getByRole('button',{name:'Send message',exact:true}).click();
  await seen(b,'cross-authenticated.bin');console.log('CHECKPOINT room file descriptor arrived through actual app');
  await writeFile(process.env.EVIDENCE_DIR+'/file-receiver.txt',await b.locator('body').innerText());
  // The file chip's user-facing action drives discovery and all signaling.
  await b.getByRole('button',{name:'Download file',exact:true}).click();
  await b.locator('a[download="cross-authenticated.bin"]').waitFor();
  const download=b.waitForEvent('download');await b.locator('a[download="cross-authenticated.bin"]').click();
  const received=await download;assert.deepEqual(await readFile(await received.path()),bytes);console.log('PASS app-driven room attachment authenticated exact-byte download');
  const c=await actor('Cross Carol');await c.goto(link);await unlock(c);await chat(c);await seen(c,'cross room live Alice');await fetchFile(c,'cross-authenticated.bin',bytes);
  await c.reload();await unlock(c);await chat(c);await fetchFile(c,'cross-authenticated.bin',bytes);console.log('PASS fresh room peer history-batch attachment download and encrypted local reopen');
  if(process.env.EXTENDED && process.env.SFU_URL){
    await a.getByRole('button',{name:'Join call',exact:true}).click();await b.getByRole('button',{name:'Join call',exact:true}).click();await a.getByRole('button',{name:'Leave call',exact:true}).first().waitFor();await b.getByRole('button',{name:'Leave call',exact:true}).first().waitFor();
    await a.getByRole('button',{name:'Turn on camera',exact:true}).first().click();await a.getByRole('button',{name:'Start camera',exact:true}).click();await b.waitForFunction(()=>[...document.querySelectorAll('video')].some(v=>!v.classList.contains('-scale-x-100') && v.srcObject instanceof MediaStream && v.srcObject.getVideoTracks().some(t=>t.readyState==='live') && v.videoWidth>0));await a.getByRole('button',{name:'Turn off camera',exact:true}).first().click();
    await b.getByRole('button',{name:'Leave call',exact:true}).first().click();await a.getByRole('button',{name:'Leave call',exact:true}).first().click();console.log('PASS ordinary room call join, SFU remote synthetic camera frames, camera off and leave');
  }
  await a.getByRole('button',{name:'Toggle user list',exact:true}).click();await a.getByText('Cross Bob',{exact:true}).last().click();await a.getByRole('button',{name:'Message',exact:true}).click();await chat(a);
  await send(a,'cross first contact DM');await a.getByLabel('Message delivered',{exact:true}).waitFor();
  await openDm(b,'Cross Alice');await seen(b,'cross first contact DM');await a.getByLabel('Message read',{exact:true}).first().waitFor();
  await send(b,'cross DM reply');await seen(a,'cross DM reply');console.log('PASS first-contact DM, delivered/read receipts and bidirectional chat');
  await a.locator('input[type=file]').first().setInputFiles({name:'cross-dm.bin',mimeType:'application/octet-stream',buffer:bytes});await a.getByRole('button',{name:'Send message',exact:true}).click();await fetchFile(b,'cross-dm.bin',bytes);console.log('PASS fresh DM file receiver: app-driven signaling and exact authenticated bytes');
  await b.reload();await unlock(b);await openDm(b,'Cross Alice');await seen(b,'cross first contact DM');await fetchFile(b,'cross-dm.bin',bytes);console.log('PASS DM persisted history and encrypted attachment reopen');
  // Closing the document destroys existing WebSockets; setOffline alone need
  // not sever already-open sockets. Then load the installed PWA offline.
  await b.evaluate(()=>navigator.serviceWorker.ready);await b.goto('about:blank');await b.context().setOffline(true);await b.goto(origin+'/app');await unlock(b);await openDm(b,'Cross Alice');await seen(b,'cross first contact DM');await fetchFile(b,'cross-dm.bin',bytes);console.log('PASS cold offline PWA unlock, DM history and authenticated local attachment');
  await send(a,'cross offline queued DM');await b.context().setOffline(false);await b.reload();await unlock(b);await openDm(b,'Cross Alice');await seen(b,'cross offline queued DM');await send(b,'cross DM reconnected');await seen(a,'cross DM reconnected');console.log('PASS DM offline-send/reconnect delivery and subsequent live reply');
  if(process.env.EXTENDED){
    const oldBlob=await b.locator('a[download="cross-dm.bin"]').getAttribute('href');
    assert.match(oldBlob,/^blob:/);
    await b.getByRole('button',{name:'Settings',exact:true}).click();await b.getByRole('button',{name:'Lock/Logout',exact:true}).click();await b.locator('#unlock-password').waitFor();
    assert.equal(await b.evaluate(async url=>{try{await fetch(url);return true;}catch{return false;}},oldBlob),false,'lock must revoke published plaintext blob URL');
    await unlock(b);await openDm(b,'Cross Alice');await fetchFile(b,'cross-dm.bin',bytes);await send(b,'cross post lock DM');await seen(a,'cross post lock DM');console.log('PASS UI lock revokes attachment URL; same-identity unlock restores file and live DM');
    await settings(a,'Data');await a.getByRole('button',{name:'Download my data',exact:true}).click();
    await a.getByPlaceholder('Passphrase (8 characters or more)').fill('cross-backup-password');await a.getByPlaceholder('Repeat the passphrase').fill('cross-backup-password');
    const backupEvent=a.waitForEvent('download');await a.getByRole('button',{name:'Download encrypted backup',exact:true}).click();const backup=await backupEvent;const backupBytes=await readFile(await backup.path());assert.ok(!backupBytes.includes(Buffer.from('cross first contact DM')));
    await settings(c,'Data');await c.locator('input[type=file][accept*="awfulbackup"]').setInputFiles({name:'cross.awfulbackup',mimeType:'application/json',buffer:backupBytes});await c.getByPlaceholder('Backup passphrase').fill('cross-backup-password');await c.getByRole('button',{name:'Open this backup',exact:true}).click();await c.getByPlaceholder('Account password from this backup').fill(password);await c.getByRole('button',{name:'Replace everything',exact:true}).click();
    await c.locator('#unlock-password').waitFor();await unlock(c);await openDm(c,'Cross Bob');await seen(c,'cross first contact DM');await fetchFile(c,'cross-dm.bin',bytes);console.log('PASS encrypted UI backup export and identity-replacing restore with DM history and exact attachment');
    await a.keyboard.press('Escape');await settings(a,'Session/Sync');await a.getByRole('button',{name:'Generate QR code',exact:true}).click();await a.getByRole('button',{name:"Can't scan? Copy a pairing code",exact:true}).click();await a.getByRole('button',{name:'Copy sync code',exact:true}).click();const code=await a.evaluate(()=>navigator.clipboard.readText());assert.ok(code.length>40);
    const d=await actor('Cross Sync Target');await settings(d,'Session/Sync');await d.getByRole('button',{name:'Scan QR code',exact:true}).click();await d.getByRole('button',{name:'Enter code manually',exact:true}).click();await d.getByPlaceholder('Paste the complete secure pairing code').fill(code);await d.getByRole('button',{name:'Connect',exact:true}).click();
    await writeFile(process.env.EVIDENCE_DIR+'/sync-target.txt',await d.locator('body').innerText());
    await d.getByPlaceholder('Account password',{exact:true}).fill(password);await d.getByRole('button',{name:'Unlock and import',exact:true}).click();
    await d.getByText('Your data has been successfully transferred.',{exact:true}).waitFor({timeout:120000});await d.getByRole('button',{name:'Continue',exact:true}).click();await unlock(d);
    await openDm(d,'Cross Bob');await seen(d,'cross first contact DM');await fetchFile(d,'cross-dm.bin',bytes);console.log('PASS device-sync full manual capability pairing, password-gated identity replacement and restored DM history/exact attachment');
  }
  assert.deepEqual(errors,[]);console.log('PASS zero uncaught page errors');
 }
}catch(e){
  for(let i=0;i<browsers.length;i++)for(const c of browsers[i].contexts())for(const p of c.pages()){
    console.error('FAIL PAGE',i,p.url(),await p.locator('body').innerText());await p.screenshot({path:`${process.env.EVIDENCE_DIR}/failure-${i}.png`,fullPage:true});
  }throw e;
}finally{await Promise.all(browsers.map(b=>b.close()));relay.close();server.closeAllConnections();await new Promise(r=>server.close(r));}
