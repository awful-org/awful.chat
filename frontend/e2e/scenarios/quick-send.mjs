/**
 * /qs end to end: two browsers that have never made an identity meet on a
 * code, and a file crosses between them over WebRTC.
 *
 * Deliberately does NOT use bootPeers - signing up is the thing this page is
 * supposed to do without.
 */
import { Peer, closeAll } from "../driver.mjs";
import { Check } from "../assert.mjs";

const check = new Check("quick send moves a file with no identity");
const alice = new Peer(9307, "Alice");
const bob = new Peer(9308, "Bob");

const qsState = `(() => JSON.stringify({
  status: window.__qs?.state.status ?? 'none',
  code: window.__qs?.state.code ?? '',
  peers: window.__qs?.state.peers ?? 0,
  offered: (window.__qs?.state.offered ?? []).map((f) => f.infoHash),
  incoming: (window.__qs?.state.incoming ?? []).map((f) => ({ h: f.infoHash, n: f.filename, s: f.size })),
  transfers: [...(window.__qs?.state.transfers ?? new Map()).values()].map((t) => ({
    h: t.infoHash, status: t.status, progress: t.progress, error: t.error ?? null,
  })),
}))()`;

try {
  await alice.start();
  await bob.start();

  await alice.go("/qs");
  // The route is off by default, and a timeout here reads as a broken app
  // rather than an unset flag.
  if (!(await alice.eval(`/Quick send/i.test(document.body.innerText)`))) {
    throw new Error("this instance has /qs off - start vite with VITE_USE_QS=true");
  }
  const host = await alice.waitFor("alice gets a code", async () => {
    const s = await alice.json(qsState);
    return s.status === "ready" && s.code ? s : null;
  });
  check.ok(/^[0-9A-HJKMNP-TV-Z]{10}$/.test(host.code), "code is a 10-character quick code", host.code);

  // The code rides in the fragment, never the path - the whole point of the
  // /r/#<code> form the app already uses for invites.
  const inBar = await alice.eval(`window.location.pathname + '|' + window.location.hash`);
  check.equal(inBar, `/qs|#${host.code}`, "code lives in the fragment");

  await bob.go(`/qs#${host.code}`);
  await bob.waitFor("bob joins the code", async () => {
    const s = await bob.json(qsState);
    return s.status === "ready" && s.code === host.code;
  });

  await alice.waitFor("the two are introduced", async () => {
    const s = await alice.json(qsState);
    return s.peers >= 1;
  });

  // Over the 512 KB inline limit, so this is a real WebTorrent transfer.
  const offered = await alice.json(`(async () => {
    const bytes = new Uint8Array(700 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
    await window.__qs.offerFiles([new File([bytes], 'holiday.bin', { type: 'application/octet-stream' })]);
    return JSON.stringify(window.__qs.state.offered.map((f) => f.infoHash));
  })()`);
  check.equal(offered.length, 1, "alice is seeding one file");

  const seen = await bob.waitFor("bob is offered the file", async () => {
    const s = await bob.json(qsState);
    return s.incoming.length ? s.incoming[0] : null;
  }, { timeout: 60_000 });
  check.equal(seen.n, "holiday.bin", "the offer names the file");
  check.equal(seen.s, 700 * 1024, "the offer carries its size");

  // Nothing downloads until a person asks - the descriptor is the sender's
  // own claim until the bytes are hashed. An announce registers the seeder
  // ("pending"), which is bookkeeping: no torrent, no bytes.
  const before = await bob.json(qsState);
  const idle = before.transfers.find((t) => t.h === seen.h);
  check.ok(
    !idle || (idle.status === "pending" && !idle.progress),
    "nothing was pulled unasked",
    before.transfers
  );

  await bob.eval(`window.__qs.acceptFile(${JSON.stringify(seen.h)})`);
  const done = await bob.waitFor("bob completes the transfer", async () => {
    const s = await bob.json(qsState);
    const t = s.transfers.find((t) => t.h === seen.h);
    if (!t || (t.status !== "complete" && t.status !== "seeding" && t.status !== "failed")) {
      return null;
    }
    return t;
  }, { timeout: 90_000 });
  check.ok(done.status !== "failed" && done.progress >= 1, "the file arrived", done);

  const saveable = await bob.eval(
    `!!document.querySelector('a[download="holiday.bin"]')`
  );
  check.ok(saveable, "a Save link is on the page");

  // The promise on the page: nothing survives it.
  const stored = await bob.json(`(async () => {
    const names = (await indexedDB.databases?.() ?? []).map((d) => d.name);
    return JSON.stringify({ names, keys: Object.keys(localStorage) });
  })()`);
  check.ok(
    !stored.names.some((n) => /quick|qs/i.test(n ?? "")),
    "no database of its own was created",
    stored.names
  );
} finally {
  check.finish();
  await closeAll([alice, bob]);
}
