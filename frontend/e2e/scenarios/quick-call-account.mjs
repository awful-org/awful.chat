/**
 * /qc with the account this device already has.
 *
 * The point is the pair of things that must BOTH be true: the person in the
 * call is the real identity - same DID, same profile, so the other side sees
 * who they actually are - while the call itself stays as disposable as a
 * guest's, in a database that goes with the tab and never touching the saved
 * rooms.
 */
import { bootPeers, closeAll, Peer, sleep } from "../driver.mjs";
import { Check } from "../assert.mjs";

const check = new Check("quick call can use the account on this device");
const [alice] = await bootPeers(["Alice"], { ports: [9307] });
const bob = new Peer(9308, "Bob");
let qcContext = null;

try {
  await bob.start();
  await alice.createRoom("Homeroom");
  await alice.waitFor("alice's app is connected", () =>
    alice.eval(`window.__awful.state.connected === true`)
  );
  // joinRoom puts our own DID in the roster, which is the only place the app
  // tab exposes it.
  const accountDid = await alice.waitFor("alice's account did", () =>
    alice.eval(`window.__awful.state.roomUsers.find((d) => d.startsWith('did:')) || null`)
  );

  const created = await alice.bidi.send("browsingContext.create", {
    type: "tab",
  });
  qcContext = created.context;
  const quick = alice.tab(qcContext);
  await quick.go("/qc");

  // A device WITH an account is asked who to be; one without is not.
  const choosing = await quick.waitFor("the choice appears", async () => {
    const stage = await quick.eval(`window.__qc?.state.stage`);
    return stage === "choosing" ? stage : null;
  });
  check.equal(choosing, "choosing", "an account on the device is offered");

  await quick.clickText("Use my account");
  await quick.waitFor("the unlock screen", () =>
    quick.eval(`window.__qc.state.stage === 'unlocking'`)
  );

  // The unlock may complete on its own from a remembered password; if not,
  // type it like a person would.
  const ready = await quick.waitFor("the account is unlocked", async () => {
    const stage = await quick.eval(`window.__qc.state.stage`);
    if (stage === "setup") return stage;
    if (stage === "failed") throw new Error(await quick.eval(`window.__qc.state.error`));
    if (await quick.fill("password", "e2e-password")) {
      await quick.clickText("Unlock");
    }
    return null;
  }, { timeout: 60_000 });
  check.equal(ready, "setup", "unlocking leads to the setup screen");

  check.equal(
    await quick.eval(`window.__qc.state.identity`),
    "account",
    "the call is being joined as the account"
  );
  check.equal(
    await quick.eval(`window.__qc.state.profile.name`),
    "Alice",
    "the account's own display name came across"
  );

  await quick.clickText("Join call");
  await quick.waitFor("in the call", async () => {
    const stage = await quick.eval(`window.__qc.state.stage`);
    if (stage === "failed") throw new Error(await quick.eval(`window.__qc.state.error`));
    return stage === "in-call";
  }, { timeout: 60_000 });

  // The real identity, not a throwaway one.
  check.equal(
    await quick.eval(`window.__qc.did()`),
    accountDid,
    "the call runs under the account's own DID"
  );
  // ...in a database that is still disposable.
  check.ok(
    /^awful-quick-/.test(await quick.eval(`window.__qc.dbName()`)),
    "the call is still written to a throwaway database"
  );
  // ...and the app tab was not disturbed.
  check.equal(
    await alice.eval(`window.__awful.state.nodeHeldElsewhere`),
    false,
    "the app tab still holds the node"
  );

  // Somebody who has never signed in sees the account's real name.
  const code = await quick.eval(`window.__qc.state.code`);
  await bob.go(`/qc#${code}`);
  await bob.waitFor("bob reaches the setup screen", () =>
    bob.eval(`window.__qc?.state.stage === 'setup'`)
  );
  await bob.fill("Your display name", "Bob");
  await bob.clickText("Join call");
  await bob.waitFor("bob is in the call", () =>
    bob.eval(`window.__qc.state.stage === 'in-call'`), { timeout: 60_000 });
  const sawName = await bob.waitFor("bob sees the account's name", () =>
    bob.eval(`[...window.__awful.state.peerNames.values()].includes('Alice')`),
    { timeout: 90_000 }
  );
  check.ok(sawName, "the other side sees the account, not a guest");

  // Closing the tab still takes everything with it, account or not.
  await alice.bidi.send("browsingContext.close", { context: qcContext });
  qcContext = null;
  await sleep(2000);
  const left = await alice.waitFor("the quick database is gone", async () => {
    const names = await alice.json(
      `indexedDB.databases().then((d) => JSON.stringify(d.map((x) => x.name).filter((n) => n && n.startsWith('awful-quick-'))))`
    );
    return names.length === 0 ? names : null;
  }, { timeout: 30_000 });
  check.equal(left.length, 0, "nothing survived the tab");

  // And the account's real database still holds only the room it had.
  const rooms = await alice.json(
    `window.__awful.state.roomCode ? JSON.stringify([window.__awful.state.roomCode]) : "[]"`
  );
  check.ok(
    !rooms.includes(code),
    "the quick call never joined the account's saved rooms",
    rooms
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
