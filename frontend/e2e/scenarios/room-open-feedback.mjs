/**
 * Clicking a room from /app changes the screen on the click: the sidebar
 * highlights, the chat pane mounts and its "Connecting..." overlay covers
 * it until the room is open. Before, nothing moved until history was
 * decrypted, the roster read and the profile broadcast.
 *
 * Deterministic without timing games: IndexedDB answers in a later task,
 * so a few microtasks after the click the join is still inside its first
 * await, and Svelte has already flushed the view.
 */
import { Peer, sleep } from "../driver.mjs";
import { Check } from "../assert.mjs";

const check = new Check("opening a room reacts on the click");
const p = new Peer(9307, "A");

try {
  await p.start();
  await p.signUp("Clicker");
  const room = await p.createRoom("FeedbackRoom");
  for (let i = 0; i < 5; i++) await p.say(`message ${i}`);
  await sleep(500);

  await p.go("/app");
  await p.waitFor("room listed", () =>
    p.eval(`[...document.querySelectorAll('button')].some((b) => /FeedbackRoom/.test(b.innerText)) || null`));
  check.ok((await p.eval(`window.__awful.state.roomCode`)) === null, "starts outside any room");

  const snap = await p.json(`(async () => {
    const btn = [...document.querySelectorAll('button')].find((b) => /FeedbackRoom/.test(b.innerText));
    btn.click();
    for (let i = 0; i < 5; i++) await Promise.resolve();
    const s = window.__awful.state;
    return JSON.stringify({
      connecting: s.connecting,
      overlay: /Connecting\\.\\.\\./.test(document.body.innerText),
      pane: !!document.querySelector('textarea'),
      opened: s.roomCode === ${JSON.stringify(room)},
    });
  })()`);
  check.ok(snap.pane, "chat pane mounts on the click", snap);
  check.ok(snap.connecting && snap.overlay, "overlay shows while the join runs", snap);

  await p.waitFor("room open", async () =>
    (await p.eval(`window.__awful.state.roomCode`)) === room && !(await p.eval(`window.__awful.state.connecting`)));
  const after = await p.json(`JSON.stringify({
    overlay: /Connecting\\.\\.\\./.test(document.body.innerText),
    messages: window.__awful.state.messages.length,
  })`);
  check.ok(!after.overlay && after.messages === 5, "overlay lifts with the history in place", after);
} finally {
  await p.close();
}

check.finish();
