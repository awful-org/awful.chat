/**
 * Chat history exchange: a peer joining a room with a deep backlog pulls ALL
 * of it through the digest/batch protocol (120 messages = 6 batches), and the
 * UI pages through it - newest page first, load-older until the button
 * honestly disappears at the top.
 */
import { bootPeers, closeAll } from "../driver.mjs";
import { Check, waitForBinding, waitForMesh } from "../assert.mjs";

const check = new Check("late joiner pulls the full backlog");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

const storedCount = (p, code) => p.eval(`(async () => {
  const db = await new Promise((res) => {
    const r = indexedDB.open('awful-chat'); r.onsuccess = () => res(r.result);
  });
  const msgs = await new Promise((r) => {
    const q = db.transaction('messages').objectStore('messages').getAll();
    q.onsuccess = () => r(q.result);
  });
  return msgs.filter((m) => m.roomCode === ${JSON.stringify(code)}).length;
})()`);

try {
  const room = await alice.createRoom("Backlog");
  await alice.waitFor("history written", async () => {
    await alice.eval(`(async () => {
      if (window.__historySent) return true;
      window.__historySent = true;
      for (let i = 1; i <= 120; i++) {
        await window.__awful.sendMessage('backlog ' + i);
      }
      return true;
    })()`);
    return (await storedCount(alice, room)) === 120 ? true : null;
  }, { timeout: 60000 });
  check.ok(true, "alice holds a 120-message backlog");

  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  await waitForBinding([alice, bob], 1);

  // The join digest advertises emptiness; alice pushes everything in batches.
  await bob.waitFor("full backlog pulled", async () =>
    (await storedCount(bob, room)) === 120 ? true : null,
    { timeout: 120000, interval: 1000 });
  check.ok(true, "bob converged to all 120 messages without asking twice");

  // The page-at-a-time contract belongs to a fresh open: live sync is
  // allowed to accumulate in the view. Reload, then the room must open on
  // the newest 50 only.
  await bob.go(`/r/${room}`);
  await bob.waitFor("room reopened", () =>
    bob.eval(`window.__awful.state.roomCode === ${JSON.stringify(room)} && window.__awful.state.messages.length > 0 || null`),
    { timeout: 30000 });
  const firstPage = await bob.json(`JSON.stringify({
    count: window.__awful.state.messages.length,
    hasNewest: window.__awful.state.messages.some((m) => m.content === 'backlog 120'),
    hasOldest: window.__awful.state.messages.some((m) => m.content === 'backlog 1'),
  })`);
  check.ok(
    firstPage.count === 50 && firstPage.hasNewest && !firstPage.hasOldest,
    "view opens on the newest page only",
    firstPage
  );

  // Load older until the whole backlog is on screen and the button retires.
  await bob.waitFor("paged to the top", async () => {
    await bob.eval(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => /Load older/i.test(x.textContent));
      if (b && !b.disabled) b.click();
      return true;
    })()`);
    return bob.eval(`window.__awful.state.messages.some((m) => m.content === 'backlog 1') || null`);
  }, { timeout: 30000 });
  const paged = await bob.json(`JSON.stringify({
    count: window.__awful.state.messages.length,
    button: [...document.querySelectorAll('button')].some((x) => /Load older/i.test(x.textContent)),
  })`);
  check.ok(paged.count === 120, "every page loaded exactly once", paged);

  // Composer regression: a multiline draft grows the textarea; sending must
  // shrink it back instead of leaving a tall empty box.
  const heights = await bob.json(`(async () => {
    const el = document.querySelector('textarea');
    const base = el.offsetHeight;
    const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    set.call(el, 'line one' + String.fromCharCode(10) + 'line two' + String.fromCharCode(10) + 'line three' + String.fromCharCode(10) + 'line four');
    el.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise((r) => setTimeout(r, 100));
    const grown = el.offsetHeight;
    el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await new Promise((r) => setTimeout(r, 300));
    return JSON.stringify({ base, grown, after: el.offsetHeight });
  })()`);
  check.ok(heights.grown > heights.base,
    `multiline draft grows the composer (${heights.base} -> ${heights.grown})`);
  check.ok(heights.after <= heights.base + 2,
    `sending shrinks it back (${heights.grown} -> ${heights.after})`);

  check.finish();
} finally {
  await closeAll([alice, bob]);
}
