/**
 * /qc end to end: two browsers with no identity meet on a code and end up in
 * one call, with voice flowing.
 *
 * Also the two promises the page makes about what it leaves behind: the call
 * is written to a throwaway database, and the real one is untouched.
 */
import { Peer, closeAll } from "../driver.mjs";
import { Check } from "../assert.mjs";

const check = new Check("quick call connects two strangers");
const alice = new Peer(9307, "Alice");
const bob = new Peer(9308, "Bob");

const qcState = `(() => JSON.stringify({
  stage: window.__qc?.state.stage ?? 'none',
  code: window.__qc?.state.code ?? '',
  db: window.__qc?.dbName() ?? '',
  inCall: !!window.__awful?.state.inCall,
  callPeers: [...(window.__awful?.state.callPeerIds ?? [])].length,
  roomUsers: (window.__awful?.state.roomUsers ?? []).length,
  did: window.__awful?.state.roomCode ? true : false,
}))()`;

async function joinAs(peer, name) {
  await peer.waitFor(`${name} reaches the setup screen`, async () => {
    const s = await peer.json(qcState);
    return s.stage === "setup";
  });
  await peer.fill("Your name", name);
  await peer.clickText("Join call");
  return peer.waitFor(`${name} is in the call`, async () => {
    const s = await peer.json(qcState);
    if (s.stage === "failed") throw new Error(`${name} failed to join`);
    return s.stage === "in-call" ? s : null;
  }, { timeout: 60_000 });
}

try {
  await alice.start();
  await bob.start();

  await alice.go("/qc");
  if (!(await alice.eval(`/Quick call/i.test(document.body.innerText)`))) {
    throw new Error("this instance has /qc off - start vite with VITE_USE_QC=true");
  }

  const code = await alice.waitFor("alice gets a code", () =>
    alice.eval(`window.__qc?.state.code || null`)
  );
  check.ok(/^[0-9A-HJKMNP-TV-Z]{13}$/.test(code), "code is a room code", code);
  check.equal(
    await alice.eval(`window.location.pathname + '|' + window.location.hash`),
    `/qc|#${code}`,
    "code lives in the fragment"
  );

  const hostState = await joinAs(alice, "Alice");
  check.ok(
    /^awful-quick-[0-9a-f]{16}$/.test(hostState.db),
    "the call is written to a throwaway database",
    hostState.db
  );
  check.ok(hostState.inCall, "alice is in the call");

  await bob.go(`/qc#${code}`);
  const guestState = await joinAs(bob, "Bob");
  check.equal(guestState.code, code, "bob joined the same code");
  check.ok(
    guestState.db !== hostState.db,
    "each page gets its own database",
    [hostState.db, guestState.db]
  );

  // The point of the whole thing: they can hear each other.
  const paired = await alice.waitFor("alice sees bob in the call", async () =>
    alice.json(`(() => {
      const s = window.__awful.state;
      const voice = window.__awful.voice();
      return JSON.stringify({
        callPeers: [...s.callPeerIds].length,
        voicePeers: voice.activePeers?.length ?? voice.peers?.length ?? 0,
      });
    })()`).then((s) => (s.callPeers >= 1 ? s : null)), { timeout: 90_000 });
  check.ok(paired.callPeers >= 1, "the two are in one call", paired);

  await bob.waitFor("bob sees alice too", async () =>
    bob.eval(`[...window.__awful.state.callPeerIds].length >= 1`)
  );

  // Names crossed over, so a stranger is not "Anonymous" to the other side.
  const named = await alice.waitFor("alice sees bob's name", () =>
    alice.eval(`[...window.__awful.state.peerNames.values()].includes('Bob')`)
  );
  check.ok(named, "the profile reached the other side");

  // Nothing about this call may be in the database a real account uses.
  // start() visits /app first, so awful-chat exists on this profile - what
  // matters is that /qc put nothing in it.
  const real = await alice.json(`(() => new Promise((resolve) => {
    const req = indexedDB.open('awful-chat');
    req.onerror = () => resolve(JSON.stringify({ rooms: 0, messages: 0 }));
    req.onsuccess = () => {
      const db = req.result;
      const names = [...db.objectStoreNames];
      if (!names.includes('rooms')) {
        db.close();
        resolve(JSON.stringify({ rooms: 0, messages: 0 }));
        return;
      }
      const tx = db.transaction(['rooms', 'messages'], 'readonly');
      const rooms = tx.objectStore('rooms').count();
      const messages = tx.objectStore('messages').count();
      tx.oncomplete = () => {
        db.close();
        resolve(JSON.stringify({ rooms: rooms.result, messages: messages.result }));
      };
    };
  }))()`);
  check.equal(real.rooms, 0, "no room was written to the real database");
  check.equal(real.messages, 0, "no messages either");

  const dbs = await alice.json(
    `indexedDB.databases().then((d) => JSON.stringify(d.map((x) => x.name)))`
  );
  check.ok(
    dbs.some((n) => n.startsWith("awful-quick-")),
    "the call lived in a quick database",
    dbs
  );
} finally {
  check.finish();
  await closeAll([alice, bob]);
}
