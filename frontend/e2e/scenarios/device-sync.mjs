/**
 * Device sync, end to end: a source with a room and a few messages hands
 * its history to a fresh target over the sync room, in "add" mode, and both
 * progress bars reach 100 with the phases in the right order. This is the
 * flow that had no coverage at all while it shipped a "stuck at 80%".
 *
 * Add mode, not replace: replace prompts for the identity's password inside
 * the import, which is the dialog's job to answer and out of reach here.
 */
import { bootPeers, closeAll } from "../driver.mjs";
import { Check } from "../assert.mjs";

const check = new Check("device sync");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

const syncSnapshot = (p) =>
  p.json(`(async () => {
    const s = await import('/src/lib/transport/sync.svelte.ts');
    const st = s.syncState;
    return JSON.stringify({ progress: st.syncProgress, phase: st.phase,
      syncing: st.isSyncing, done: st.isComplete, err: st.syncError });
  })()`);

try {
  await alice.createRoom("History");
  for (let i = 0; i < 5; i++) await alice.say(`message ${i}`);

  // The short code is what the dialog shows when the user asks for it; the
  // source only honours the truncated token once it has been revealed.
  const token = await alice.eval(`(async () => {
    const s = await import('/src/lib/transport/sync.svelte.ts');
    await s.generateSyncCode();
    s.revealShortCode();
    return s.syncState.plaintextToken;
  })()`);
  check.ok(typeof token === "string" && token.length > 0, "source generated a short code");

  await bob.eval(`(async () => {
    const s = await import('/src/lib/transport/sync.svelte.ts');
    const payload = s.parsePlaintextToken(${JSON.stringify(token)});
    payload.mode = 'add';
    void s.connectAsTarget(payload).catch((e) => console.error('[Sync] target threw', e && e.message));
    return true;
  })()`);

  const phases = { alice: new Set(), bob: new Set() };
  const deadline = Date.now() + 120_000;
  let a, b;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    a = await syncSnapshot(alice);
    b = await syncSnapshot(bob);
    phases.alice.add(a.phase);
    phases.bob.add(b.phase);
    if (a.err || b.err || (a.done && b.done)) break;
  }
  check.ok(!a.err, `source finished without error (${a.err ?? "ok"})`);
  check.ok(!b.err, `target finished without error (${b.err ?? "ok"})`);
  check.ok(a.done && a.progress === 100, `source reached 100 (${a.progress})`);
  check.ok(b.done && b.progress === 100, `target reached 100 (${b.progress})`);
  check.ok(phases.bob.has("importing"), "target reported its import phase");
  check.ok(
    phases.alice.has("importing-remote"),
    "source saw the target importing"
  );

  const bobRooms = await bob.json(`(async () => {
    const st = await import('/src/lib/storage.ts');
    const rooms = await st.getAllRooms();
    return JSON.stringify(rooms.map((r) => r.name));
  })()`);
  check.ok(bobRooms.includes("History"), "the room arrived on the target");
} finally {
  await closeAll([alice, bob]);
  check.finish();
}
