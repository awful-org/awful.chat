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

  // Hanging up is a decision: a reload after it must not walk back in.
  // ChatView puts leaving behind a two-click confirm.
  check.ok(await alice.clickLabel("Delete room"), "the leave control is there");
  await sleep(300);
  await alice.clickLabel("Delete room");
  await alice.waitFor("alice leaves", () =>
    alice.eval(`window.__qc.state.stage !== 'in-call'`)
  );
  await sleep(1500);
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
