/**
 * One libp2p node per browser profile (node-lock.ts).
 *
 * Two tabs of the same profile share the libp2p seed and so the peerId; two
 * nodes with one peerId starve each other of pongs and reconnect every ~125 s
 * (the 2026-09-04 and 2026-09-06 diag packs). The second tab must wait, say
 * so, take the seat on "Use here", and hand it back when it closes.
 */
import { bootPeers, closeAll, sleep } from "../driver.mjs";
import { Check, waitForMesh } from "../assert.mjs";

const check = new Check("one node per browser profile");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });
let tab2Context = null;

try {
  const room = await alice.createRoom("TabLab");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  const aliceId = await alice.selfId();

  // A second tab of Alice's profile.
  ({ context: tab2Context } = await alice.bidi.send("browsingContext.create", { type: "tab" }));
  const tab2 = alice.tab(tab2Context);
  await tab2.go("/app");
  await tab2.waitFor("other-tab bar", () =>
    tab2.eval(`/open in another tab/i.test(document.body.innerText) || null`));
  check.ok(true, "second tab says the app is open in another tab");
  await sleep(4000);
  check.ok(
    (await tab2.eval(`window.__awful.state.relayConnected`)) === false,
    "second tab did not start a node"
  );
  let a = await alice.state();
  let b = await bob.state();
  check.ok(a.relay && a.peers === 1 && b.peers === 1, "first tab kept the node and the mesh");

  // "Use here": the second tab takes the seat, the first steps down and waits.
  await tab2.clickText("Use here");
  await tab2.waitFor("tab2 connected", () =>
    tab2.eval(`window.__awful.state.relayConnected || null`));
  await alice.waitFor("tab1 waiting", () =>
    alice.eval(`window.__awful.state.nodeHeldElsewhere || null`));
  check.ok((await alice.eval(`window.__awful.state.relayConnected`)) === false,
    "Use here moves the node to the second tab; the first waits");
  check.ok((await tab2.selfId()) === aliceId, "same peerId in the second tab");
  await tab2.openRoom(room);
  await waitForMesh([tab2, bob], 1);
  check.ok(true, "the second tab reaches Bob with that peerId");

  // Closing the holder hands the seat back to the tab that waited.
  await alice.bidi.send("browsingContext.close", { context: tab2Context });
  tab2Context = null;
  await alice.waitFor("tab1 back", () =>
    alice.eval(`(window.__awful.state.relayConnected && !window.__awful.state.nodeHeldElsewhere) || null`));
  await waitForMesh([alice, bob], 1);
  check.ok(true, "closing the tab hands the node back and the mesh reforms");
} finally {
  if (tab2Context) {
    await alice.bidi.send("browsingContext.close", { context: tab2Context }).catch(() => {});
  }
  check.finish();
  await closeAll([alice, bob]);
}
