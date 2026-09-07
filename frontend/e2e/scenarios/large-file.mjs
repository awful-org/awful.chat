/**
 * A file over the inline limit (512 KB) still arrives over WebTorrent after
 * the dial cap: one announce, one request, one link, and the transfer
 * completes on the receiver.
 */
import { bootPeers, closeAll } from "../driver.mjs";
import { Check, waitForMesh, waitForBinding } from "../assert.mjs";

const check = new Check("large file still arrives over webtorrent");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

try {
  const room = await alice.createRoom("FileLab");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  await waitForBinding([alice, bob], 1);

  await alice.eval(`(() => {
    const bytes = new Uint8Array(700 * 1024);
    for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31) & 0xff;
    const file = new File([bytes], 'big.png', { type: 'image/png' });
    window.__awful.sendFiles([file], 'big one');
    return true;
  })()`);

  // A finished download turns into a seed, so "seeding" is the end state.
  const snap = await bob.waitFor("bob completes the download", () =>
    bob.json(`(() => {
      const t = [...window.__awful.state.fileTransfers.values()][0];
      if (!t || (t.status !== 'seeding' && t.status !== 'complete' && t.status !== 'failed')) return null;
      return JSON.stringify({ status: t.status, progress: t.progress, error: t.error ?? null });
    })()`), { timeout: 90_000 });
  check.ok(snap.status !== "failed" && snap.progress >= 1, "receiver's transfer completes", snap);
} finally {
  check.finish();
  await closeAll([alice, bob]);
}
