/**
 * A file ABOVE the persistence cap, to two receivers at once.
 *
 * large-file.mjs sends 700 KB, which is over the inline limit but under
 * MAX_PERSISTED_ATTACHMENT_BYTES (5 MB), so its bytes are stored and every
 * announce path can see it. Past 5 MB nothing is stored - not on the
 * sender's side either - and getSeedableFiles() only returns rows that have
 * bytes, so _announceStoredFilesTo can never mention it. The only things
 * that can are the emit at send time and the one on a new peer connection.
 *
 * Reported from a real instance: a 22 MB image, five people in the room, the
 * sender still seeding in the same session, and every receiver stuck on a
 * skeleton with no progress at all - which is the shape of "nobody ever
 * learned who has it" rather than "the link would not form".
 */
import { bootPeers, closeAll, sleep } from "../driver.mjs";
import { Check, waitForMesh, waitForBinding } from "../assert.mjs";

const check = new Check("a file past the persistence cap still reaches everyone");
const [alice, bob, carol] = await bootPeers(["Alice", "Bob", "Carol"], {
  ports: [9307, 9308, 9309],
});

/** Well past MAX_PERSISTED_ATTACHMENT_BYTES, small enough to move in a test. */
const SIZE = 8 * 1024 * 1024;

const snap = `(() => {
  const t = [...window.__awful.state.fileTransfers.values()][0];
  if (!t) return JSON.stringify({ none: true });
  return JSON.stringify({
    status: t.status, progress: t.progress, seeders: t.seeders,
    peers: t.peers, error: t.error ?? null,
  });
})()`;

try {
  const room = await alice.createRoom("BigLab");
  await bob.joinRoom(room);
  await carol.joinRoom(room);
  await waitForMesh([alice, bob, carol], 2);
  await waitForBinding([alice, bob, carol], 2);

  await alice.eval(`(() => {
    const bytes = new Uint8Array(${SIZE});
    for (let i = 0; i < bytes.length; i += 4096) bytes[i] = (i * 31) & 0xff;
    const file = new File([bytes], 'big.png', { type: 'image/png' });
    window.__awful.sendFiles([file], 'the big one');
    return true;
  })()`);

  // The sender holds it, but only in memory: nothing this large is written.
  const mine = await alice.waitFor("alice is seeding it", async () => {
    const s = await alice.json(snap);
    return s.status === "seeding" ? s : null;
  }, { timeout: 60_000 });
  check.ok(mine.status === "seeding", "the sender is seeding", mine);

  // Both receivers have to at least LEARN that somebody has it. A transfer
  // that never hears of a seeder never dials, so nothing times out and
  // nothing fails - it just sits there, which is the reported symptom.
  for (const [peer, name] of [[bob, "Bob"], [carol, "Carol"]]) {
    const seen = await peer.waitFor(`${name} hears about a seeder`, async () => {
      const s = await peer.json(snap);
      return !s.none && s.seeders > 0 ? s : null;
    }, { timeout: 60_000 }).catch(async () => ({
      failed: true,
      last: await peer.json(snap),
    }));
    check.ok(
      !seen.failed,
      `${name} was told who has the file`,
      seen.failed ? seen.last : seen
    );
  }

  for (const [peer, name] of [[bob, "Bob"], [carol, "Carol"]]) {
    const got = await peer.waitFor(`${name} completes it`, async () => {
      const s = await peer.json(snap);
      if (s.none) return null;
      if (["seeding", "complete", "failed"].includes(s.status)) return s;
      return null;
    }, { timeout: 180_000 }).catch(async () => ({
      failed: true,
      last: await peer.json(snap),
    }));
    check.ok(
      !got.failed && got.status !== "failed" && got.progress >= 1,
      `${name} got the whole file`,
      got.failed ? got.last : got
    );
  }
} finally {
  check.finish();
  await closeAll([alice, bob, carol]);
}
