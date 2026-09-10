/**
 * Two things /qc got wrong that the app gets right, because /qc mounts no
 * AppView and a page load is not the same thing twice.
 *
 * 1. The speaking ring. Detection is fed by an effect that lived in AppView,
 *    so a quick call had every part of the indicator except the thing that
 *    drives it, and nobody ever lit up. What is checked here is that the
 *    analyser is being FED - whether a ring visibly lights needs an audible
 *    microphone and an AudioContext the browser has allowed to run, and a
 *    headless run has neither (the app scores an empty `speaking` set in this
 *    harness too). An empty `tracked` while a call is up is the actual bug:
 *    nobody calling updateSpeakerTracks at all.
 *
 * 2. A refresh. It used to be a silent eviction: a new identity, back on the
 *    setup card being told you had been "invited" to the call you started,
 *    and a ghost of you left in everyone else's roster. It should be a
 *    reconnect - same person, straight back in.
 */
import { Peer, closeAll, sleep } from "../driver.mjs";
import { Check } from "../assert.mjs";

const check = new Check("a quick call speaks and survives a refresh");
const alice = new Peer(9307, "Alice");
const bob = new Peer(9308, "Bob");

const state = `JSON.stringify({
  stage: window.__qc?.state.stage,
  code: window.__qc?.state.code,
  did: window.__qc?.did(),
  inCall: !!window.__awful?.state.inCall,
  callPeers: [...(window.__awful?.state.callPeerIds ?? [])].length,
  names: [...(window.__awful?.state.peerNames?.values() ?? [])],
})`;

async function join(peer, name) {
  await peer.waitFor(`${name} reaches the setup screen`, () =>
    peer.eval(`window.__qc?.state.stage === 'setup'`)
  );
  if (!(await peer.fill("Your display name", name))) {
    throw new Error(`${name}: no name field`);
  }
  await peer.clickText("Join call");
  await peer.waitFor(`${name} is in the call`, async () => {
    const s = await peer.json(state);
    if (s.stage === "failed") throw new Error(await peer.eval(`window.__qc.state.error`));
    return s.stage === "in-call";
  }, { timeout: 60_000 });
}

try {
  await alice.start();
  await bob.start();

  await alice.go("/qc");
  const code = await alice.waitFor("alice gets a code", () =>
    alice.eval(`window.__qc?.state.code || null`)
  );

  // The host, before joining: a refresh here must not tell them they were
  // invited to their own call.
  check.ok(
    await alice.eval(`document.body.innerText.includes('Send the link')`),
    "the host is told it is their call"
  );

  await join(alice, "Alice");
  await bob.go(`/qc#${code}`);
  await join(bob, "Bob");
  await alice.waitFor("the two are in one call", () =>
    alice.eval(`[...window.__awful.state.callPeerIds].length >= 1`),
    { timeout: 90_000 }
  );

  const heard = await alice.waitFor("the analyser is fed", async () => {
    const s = await alice.json(`JSON.stringify(window.__speakers())`);
    return s.tracked.length ? s : null;
  }, { timeout: 60_000 });
  check.ok(heard.tracked.length > 0, "the speaking ring has something to light", heard);

  const before = await alice.json(state);

  // A real reload, not a same-document hash navigation.
  await alice.bidi.send("browsingContext.reload", {
    context: alice.bidi.context,
    wait: "complete",
  });

  const after = await alice.waitFor("alice walks back into the call", async () => {
    const s = await alice.json(state);
    if (s.stage === "failed") throw new Error(await alice.eval(`window.__qc.state.error`));
    return s.stage === "in-call" ? s : null;
  }, { timeout: 90_000 });

  check.equal(after.code, before.code, "the same call");
  check.equal(after.did, before.did, "as the same person, so no ghost is left behind");
  check.ok(after.inCall, "and actually in it, without asking anything again");

  // The other side sees a reconnect, not a stranger: one peer, still named.
  const bobSees = await bob.waitFor("bob still has exactly one peer", async () => {
    const s = await bob.json(state);
    return s.callPeers === 1 && s.names.includes("Alice") ? s : null;
  }, { timeout: 90_000 });
  check.equal(bobSees.callPeers, 1, "no duplicate of alice appeared", bobSees);

  // And the page that came back is feeding it too.
  const heardAgain = await alice.waitFor("the analyser is fed after the reload", async () => {
    const s = await alice.json(`JSON.stringify(window.__speakers())`);
    return s.tracked.length ? s : null;
  }, { timeout: 60_000 });
  check.ok(heardAgain.tracked.length > 0, "detection survived the reload", heardAgain);

  // Hanging up takes the call with it: the chat, and the database it lived in.
  const dbs = `indexedDB.databases().then((d) => JSON.stringify(
    d.map((x) => x.name).filter((n) => n && n.startsWith('awful-quick-'))))`;
  const during = await alice.json(dbs);
  check.equal(during.length, 1, "the call has a database while it runs", during);
  const callDb = await alice.eval(`window.__qc.dbName()`);

  // The red hang-up in the call bar, which is the button a person reaches
  // for. In a room it leaves the CALL and keeps the conversation; here it has
  // to end the whole thing, the way every other call app does - and on one
  // click, because an unsignposted confirm reads as a button that is broken.
  check.ok(
    await alice.clickLabel("Leave call"),
    "the hang-up is where a person looks for it"
  );
  await alice.waitFor("the call ends on one click", () =>
    alice.eval(`window.__qc.state.stage === 'ended'`)
  );
  check.ok(
    await alice.eval(`document.body.innerText.includes('Call ended')`),
    "and the page says the call ended"
  );

  // The bytes, gone. Not "gone when the tab closes" - gone now.
  //
  // What may remain is the EMPTY scope the drop rotates to, because leaveRoom
  // finishes asynchronously and its participant removal has to land somewhere
  // disposable rather than in the user's real database. So the promise is
  // about the database the call actually wrote to, by name.
  const left = await alice.waitFor("the call's database goes with it", async () => {
    const names = await alice.json(dbs);
    return names.includes(callDb) ? null : names;
  }, { timeout: 30_000 });
  check.ok(!left.includes(callDb), "nothing the call wrote survived it", {
    callDb,
    left,
  });
  check.ok(
    left.every((n) => n !== callDb),
    "and whatever is left is a different, empty scope",
    left
  );

  // And a reload lands on a fresh page rather than walking back in.
  await alice.bidi.send("browsingContext.reload", {
    context: alice.bidi.context,
    wait: "complete",
  });
  await sleep(4000);
  const afterLeave = await alice.json(state);
  check.ok(
    afterLeave.stage !== "in-call",
    "a reload after leaving stays out",
    afterLeave
  );
} finally {
  check.finish();
  await closeAll([alice, bob]);
}
