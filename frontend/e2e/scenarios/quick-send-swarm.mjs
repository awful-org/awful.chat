/**
 * /qs is multi-peer: the link is a swarm, not a queue at the sender.
 *
 * The claim being tested is the one that actually matters, and it is not
 * "three people can download" - it is that the SENDER CAN LEAVE. Alice offers
 * a file, Bob takes it, Alice closes her page entirely, and only then does
 * Carol arrive. The bytes Carol gets can only have come from Bob.
 */
import { Peer, closeAll, sleep } from "../driver.mjs";
import { Check } from "../assert.mjs";

const check = new Check("a quick send survives the sender leaving");
const alice = new Peer(9307, "Alice");
const bob = new Peer(9308, "Bob");
const carol = new Peer(9309, "Carol");

const qsState = `(() => JSON.stringify({
  status: window.__qs?.state.status ?? 'none',
  code: window.__qs?.state.code ?? '',
  peers: window.__qs?.state.peers ?? 0,
  incoming: (window.__qs?.state.incoming ?? []).map((f) => ({ h: f.infoHash, n: f.filename })),
  transfers: [...(window.__qs?.state.transfers ?? new Map()).values()].map((t) => ({
    h: t.infoHash, status: t.status, progress: t.progress, seeding: !!t.seeding,
    seeders: t.seeders ?? 0, error: t.error ?? null,
  })),
}))()`;

/** Take the one file on offer and wait for it to land. */
async function receive(peer, name) {
  const offered = await peer.waitFor(`${name} is offered the file`, async () => {
    const s = await peer.json(qsState);
    return s.incoming.length ? s.incoming[0] : null;
  }, { timeout: 60_000 });
  await peer.eval(`window.__qs.acceptFile(${JSON.stringify(offered.h)})`);
  return peer.waitFor(`${name} completes the download`, async () => {
    const s = await peer.json(qsState);
    const t = s.transfers.find((t) => t.h === offered.h);
    if (!t || (t.status !== "complete" && t.status !== "seeding" && t.status !== "failed")) {
      return null;
    }
    return t;
  }, { timeout: 90_000 });
}

try {
  await alice.start();
  await bob.start();
  await carol.start();

  await alice.go("/qs");
  const code = await alice.waitFor("alice gets a code", () =>
    alice.eval(`window.__qs?.state.status === 'ready' ? window.__qs.state.code : null`)
  );

  // Over the inline limit, so this is a real WebTorrent transfer.
  await alice.eval(`(async () => {
    const bytes = new Uint8Array(700 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 13) & 0xff;
    await window.__qs.offerFiles([new File([bytes], 'party.bin')]);
    return true;
  })()`);

  await bob.go(`/qs#${code}`);
  const bobGot = await receive(bob, "Bob");
  check.ok(bobGot.status !== "failed" && bobGot.progress >= 1, "bob got it from alice", bobGot);

  // Bob serves it on: that is what makes the next arrival possible.
  const bobSeeding = await bob.waitFor("bob starts sharing it on", async () => {
    const s = await bob.json(qsState);
    return s.transfers.some((t) => t.seeding) ? s : null;
  }, { timeout: 30_000 });
  check.ok(bobSeeding !== null, "bob is seeding what he received");

  // Alice leaves. Not a background tab - the page is gone, its transport
  // disconnected and its in-memory copy of the file with it.
  await alice.go("/");
  await alice.waitFor("alice's page is gone", () =>
    alice.eval(`!window.__qs || window.__qs.state.status === 'idle'`)
  );
  await sleep(3000);

  // Only now does Carol arrive, so nothing she gets can have come from Alice.
  await carol.go(`/qs#${code}`);
  const carolGot = await receive(carol, "Carol");
  check.ok(
    carolGot.status !== "failed" && carolGot.progress >= 1,
    "carol got it with the sender gone",
    carolGot
  );

  // And she now serves it too, so the swarm outlives any one member.
  const carolSeeding = await carol.waitFor("carol shares it on as well", async () => {
    const s = await carol.json(qsState);
    return s.transfers.some((t) => t.seeding);
  }, { timeout: 30_000 });
  check.ok(carolSeeding, "every finished receiver becomes a source");
} finally {
  check.finish();
  await closeAll([alice, bob, carol]);
}
