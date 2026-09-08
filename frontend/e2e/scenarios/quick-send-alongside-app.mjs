/**
 * /qs in a second tab of a profile that already has the app open.
 *
 * The app runs ONE libp2p node per browser profile, elected with a Web Lock,
 * because two nodes sharing one peerId starve each other (node-lock.ts, the
 * 2026-09-04 and 09-06 diag packs). /qs is a second node in that same profile
 * - it dodges the seat by connecting with no key seed, so it has a peerId of
 * its own and takes no lock. This is the check that it stays that way: the
 * app tab must not be told the node is held elsewhere, and the quick send
 * must still move a file.
 */
import { bootPeers, closeAll, Peer } from "../driver.mjs";
import { Check } from "../assert.mjs";

const check = new Check("quick send does not steal the app's node");
const [alice] = await bootPeers(["Alice"], { ports: [9307] });
const bob = new Peer(9308, "Bob");
let qsContext = null;

try {
  await bob.start();
  await alice.createRoom("Nodelab");
  await alice.waitFor("alice's app is connected", () =>
    alice.eval(`window.__awful.state.connected === true`)
  );

  // A second tab of the SAME profile: same Lock Manager, same device key.
  const created = await alice.bidi.send("browsingContext.create", {
    type: "tab",
  });
  qsContext = created.context;
  const quick = alice.tab(qsContext);
  await quick.go("/qs");

  const code = await quick.waitFor("the quick tab connects", () =>
    quick.eval(
      `window.__qs?.state.status === 'ready' ? window.__qs.state.code : null`
    )
  );

  // The whole point: the app tab kept its seat.
  const held = await alice.eval(`window.__awful.state.nodeHeldElsewhere`);
  check.equal(held, false, "the app tab still holds the node");
  check.ok(
    await alice.eval(`window.__awful.state.connected === true`),
    "the app tab is still connected"
  );
  check.ok(
    (await quick.eval(`window.__qs.state.code`)) === code,
    "the quick tab is not queued behind it"
  );

  await bob.go(`/qs#${code}`);
  await bob.waitFor("bob joins", () =>
    bob.eval(`window.__qs?.state.status === 'ready'`)
  );
  await quick.waitFor("the two are introduced", () =>
    quick.eval(`window.__qs.state.peers >= 1`)
  );

  const hash = await quick.eval(`(async () => {
    const bytes = new Uint8Array(700 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7) & 0xff;
    await window.__qs.offerFiles([new File([bytes], 'alongside.bin')]);
    return window.__qs.state.offered[0].infoHash;
  })()`);

  await bob.waitFor("bob is offered the file", () =>
    bob.eval(`window.__qs.state.incoming.length > 0`)
  );
  await bob.eval(`window.__qs.acceptFile(${JSON.stringify(hash)})`);
  const done = await bob.waitFor("bob completes the transfer", async () =>
    bob.json(`(() => {
      const t = window.__qs.state.transfers.get(${JSON.stringify(hash)});
      if (!t || (t.status !== 'complete' && t.status !== 'seeding' && t.status !== 'failed')) return null;
      return JSON.stringify({ status: t.status, progress: t.progress, error: t.error ?? null });
    })()`), { timeout: 90_000 });
  check.ok(done.status !== "failed" && done.progress >= 1, "the file arrived", done);

  // And the app is still itself afterwards.
  check.ok(
    await alice.eval(`window.__awful.state.connected === true`),
    "the app tab survived the whole thing"
  );
} finally {
  check.finish();
  if (qsContext) {
    await alice.bidi
      .send("browsingContext.close", { context: qsContext })
      .catch(() => {});
  }
  await closeAll([alice, bob]);
}
