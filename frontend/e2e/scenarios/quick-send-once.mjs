/**
 * A one-time /qs link is dead after it delivers.
 *
 * The mirror image of quick-send-swarm.mjs, and the assertion that matters is
 * the negative one: Alice offers with the one-time switch on, Bob takes the
 * file, and Carol - who arrives afterwards with the same link, while Alice's
 * page is still open - is offered nothing at all. Bob has the bytes and does
 * not serve them; Alice has left the room.
 */
import { Peer, closeAll, sleep } from "../driver.mjs";
import { Check } from "../assert.mjs";

const check = new Check("a one-time quick send closes after it delivers");
const alice = new Peer(9307, "Alice");
const bob = new Peer(9308, "Bob");
const carol = new Peer(9309, "Carol");

const qsState = `(() => JSON.stringify({
  status: window.__qs?.state.status ?? 'none',
  code: window.__qs?.state.code ?? '',
  peers: window.__qs?.state.peers ?? 0,
  mode: window.__qs?.state.mode ?? '',
  heardMode: window.__qs?.state.heardMode ?? '',
  closed: !!window.__qs?.state.closed,
  incoming: (window.__qs?.state.incoming ?? []).map((f) => f.infoHash),
  transfers: [...(window.__qs?.state.transfers ?? new Map()).values()].map((t) => ({
    h: t.infoHash, status: t.status, progress: t.progress, seeding: !!t.seeding,
  })),
}))()`;

try {
  await alice.start();
  await bob.start();
  await carol.start();

  await alice.go("/qs");
  const code = await alice.waitFor("alice gets a code", () =>
    alice.eval(`window.__qs?.state.status === 'ready' ? window.__qs.state.code : null`)
  );

  // The switch, through the DOM: it is the thing being shipped.
  const flipped = await alice.eval(`(() => {
    const box = [...document.querySelectorAll('input[type=checkbox]')][0];
    if (!box) return false;
    box.click();
    return true;
  })()`);
  check.ok(flipped, "the one-time switch is on the page");
  check.equal(await alice.eval(`window.__qs.state.mode`), "once", "it turns the link one-time");

  await alice.eval(`(async () => {
    const bytes = new Uint8Array(700 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 17) & 0xff;
    await window.__qs.offerFiles([new File([bytes], 'secret.bin')]);
    return true;
  })()`);

  await bob.go(`/qs#${code}`);
  const offered = await bob.waitFor("bob is offered the file", async () => {
    const s = await bob.json(qsState);
    return s.incoming.length ? s.incoming[0] : null;
  }, { timeout: 60_000 });
  check.equal(
    await bob.eval(`window.__qs.state.heardMode`),
    "once",
    "bob is told the link is one-time"
  );

  await bob.eval(`window.__qs.acceptFile(${JSON.stringify(offered)})`);
  const bobGot = await bob.waitFor("bob completes the download", async () => {
    const s = await bob.json(qsState);
    const t = s.transfers.find((t) => t.h === offered);
    if (!t || (t.status !== "complete" && t.status !== "seeding" && t.status !== "failed")) {
      return null;
    }
    return t;
  }, { timeout: 90_000 });
  check.ok(bobGot.status !== "failed" && bobGot.progress >= 1, "bob got the file", bobGot);
  check.equal(bobGot.seeding, false, "bob does not serve it on");

  // Alice's page is STILL OPEN - what closes the link is the delivery.
  const closed = await alice.waitFor("alice's link closes itself", async () => {
    const s = await alice.json(qsState);
    return s.closed ? s : null;
  }, { timeout: 30_000 });
  check.equal(closed.status, "closed", "the link reports itself closed");
  check.ok(
    await alice.eval(`document.body.innerText.includes('this link is closed')`),
    "and says so on the page"
  );

  // Carol arrives with a link that used to work. Give the room every chance
  // to offer her something - a miss has to be a real miss, not impatience.
  await carol.go(`/qs#${code}`);
  await carol.waitFor("carol's page is up", () =>
    carol.eval(`window.__qs?.state.status === 'ready'`)
  );
  await sleep(20_000);
  const carolState = await carol.json(qsState);
  check.equal(carolState.incoming.length, 0, "carol is offered nothing", carolState);
  check.equal(carolState.transfers.length, 0, "and pulls nothing", carolState);
} finally {
  check.finish();
  await closeAll([alice, bob, carol]);
}
