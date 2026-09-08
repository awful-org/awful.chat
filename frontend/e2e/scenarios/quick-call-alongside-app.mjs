/**
 * /qc in a second tab of a profile that is already signed in, and what it
 * leaves behind when that tab closes.
 *
 * Two things are being pinned. The app runs ONE libp2p node per profile,
 * elected with a Web Lock (node-lock.ts) - a quick call must not take that
 * seat from the tab holding the user's account. And the whole promise of the
 * page is that the call is gone afterwards: its database must not outlive it.
 */
import { bootPeers, closeAll, Peer, sleep } from "../driver.mjs";
import { Check } from "../assert.mjs";

const check = new Check("quick call runs beside the app and cleans up");
const [alice] = await bootPeers(["Alice"], { ports: [9307] });
const bob = new Peer(9308, "Bob");
let qcContext = null;

/** Quick databases this browser profile currently has. */
const QUICK_DBS = `indexedDB.databases().then((d) =>
  JSON.stringify(d.map((x) => x.name).filter((n) => n && n.startsWith('awful-quick-'))))`;

try {
  await bob.start();
  await alice.createRoom("Callab");
  await alice.waitFor("alice's app is connected", () =>
    alice.eval(`window.__awful.state.connected === true`)
  );

  const created = await alice.bidi.send("browsingContext.create", {
    type: "tab",
  });
  qcContext = created.context;
  const quick = alice.tab(qcContext);
  await quick.go("/qc");

  // This profile HAS an account, so /qc asks who to be first. Guest, here:
  // the account path has its own scenario.
  await quick.waitFor("the choice appears", () =>
    quick.eval(`window.__qc?.state.stage === 'choosing'`)
  );
  await quick.clickText("Join as a guest");
  await quick.waitFor("the quick tab is ready", async () =>
    quick.eval(`window.__qc.state.stage === 'setup'`)
  );
  if (!(await quick.fill("Your display name", "Guest"))) {
    throw new Error("no name field on the quick setup screen");
  }
  await quick.clickText("Join call");
  const code = await quick.waitFor("the quick tab joins its call", async () => {
    const stage = await quick.eval(`window.__qc.state.stage`);
    if (stage === "failed") throw new Error(await quick.eval(`window.__qc.state.error`));
    return stage === "in-call" ? quick.eval(`window.__qc.state.code`) : null;
  }, { timeout: 60_000 });

  // The app tab kept its seat and its connection.
  check.equal(
    await alice.eval(`window.__awful.state.nodeHeldElsewhere`),
    false,
    "the app tab still holds the node"
  );
  check.ok(
    await alice.eval(`window.__awful.state.connected === true`),
    "the app tab is still connected"
  );
  // And is still in its OWN room, not the call's.
  check.ok(
    (await alice.eval(`window.__awful.state.roomCode`)) !== code,
    "the app tab was not dragged into the call"
  );

  // A second person, from a browser that has never signed in.
  await bob.go(`/qc#${code}`);
  await bob.waitFor("bob reaches the setup screen", () =>
    bob.eval(`window.__qc?.state.stage === 'setup'`)
  );
  if (!(await bob.fill("Your display name", "Bob"))) {
    throw new Error("no name field on bob's setup screen");
  }
  await bob.clickText("Join call");
  await bob.waitFor("bob is in the call", () =>
    bob.eval(`window.__qc.state.stage === 'in-call'`), { timeout: 60_000 });
  await quick.waitFor("the two are in one call", () =>
    quick.eval(`[...window.__awful.state.callPeerIds].length >= 1`),
    { timeout: 90_000 }
  );
  check.ok(true, "a signed-in profile can hold a quick call beside its app");

  const during = await alice.json(QUICK_DBS);
  check.equal(during.length, 1, "the call has a database of its own", during);

  // Close the quick tab: pagehide fires, the database goes.
  await alice.bidi.send("browsingContext.close", { context: qcContext });
  qcContext = null;
  await sleep(2000);

  const after = await alice.waitFor("the quick database is gone", async () => {
    const names = await alice.json(QUICK_DBS);
    return names.length === 0 ? names : null;
  }, { timeout: 30_000 });
  check.equal(after.length, 0, "nothing survived the tab", after);

  check.ok(
    await alice.eval(`window.__awful.state.connected === true`),
    "the app tab survived the whole thing"
  );
} finally {
  check.finish();
  if (qcContext) {
    await alice.bidi
      .send("browsingContext.close", { context: qcContext })
      .catch(() => {});
  }
  await closeAll([alice, bob]);
}
