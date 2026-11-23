/**
 * Deleting a DM conversation must delete its history, unsubscribe its topic
 * and hang up a call held in it - and a NEW incoming message recreates the
 * thread without resurrecting the deleted history.
 */
import { bootPeers, closeAll, sleep } from "../driver.mjs";
import { Check, waitForBinding, waitForMesh } from "../assert.mjs";

const check = new Check("dm removal tears down and stays deleted");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

const dmState = (p, code) => p.json(`(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('awful-chat');
    r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
  });
  const get = (store) => new Promise((r) => {
    const q = db.transaction(store).objectStore(store).getAll();
    q.onsuccess = () => r(q.result);
  });
  const [rooms, msgs] = await Promise.all([get('rooms'), get('messages')]);
  return JSON.stringify({
    room: rooms.some((r) => r.roomCode === ${JSON.stringify(code)}),
    contents: msgs.filter((m) => m.roomCode === ${JSON.stringify(code)}).map((m) => m.content),
  });
})()`);

try {
  const room = await alice.createRoom("Meet");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  await waitForBinding([alice, bob], 1);

  // Open the DM through the app's own module (vite serves one instance in dev).
  await alice.eval(`(async () => {
    const dids = [...window.__awful.peerIdToDid.values()];
    const m = await import('/src/lib/transport/dm.svelte.ts');
    await m.openDmConversation(dids[0]);
    return true;
  })()`);
  const dmCode = await alice.waitFor("dm open", () =>
    alice.eval(`(window.__awful.state.chatMode === 'dm' && window.__awful.state.roomCode) || null`));
  await alice.say("dm before removal");
  await bob.waitFor("dm delivered", async () => {
    const s = await dmState(bob, dmCode);
    return s.contents.includes("dm before removal") ? s : null;
  });
  check.ok(true, `dm conversation established (${dmCode.slice(0, 10)})`);

  // A call held in the DM room must die with it.
  await alice.eval(`(() => {
    const s = window.__awful.state;
    s.inCall = true; s.callRoomCode = ${JSON.stringify(dmCode)};
    return true;
  })()`);

  // Remove through the real UI: Direct messages on the rail, right-click the
  // row, Remove conversation.
  await alice.waitFor("dm context menu", async () => {
    await alice.eval(`(() => {
      const dms = [...document.querySelectorAll('aside nav button')].find((b) => /^Direct messages/.test(b.textContent.trim()));
      dms?.click();
      return true;
    })()`);
    await alice.eval(`(() => {
      const row = [...document.querySelectorAll('aside [role=none], aside div')]
        .flatMap((d) => [...d.querySelectorAll('button')])
        .find((b) => /BobTest|Bob/.test(b.innerText));
      row?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 300, clientY: 300 }));
      return true;
    })()`);
    return alice.eval(`[...document.querySelectorAll('button')].some((b) => /Remove conversation/.test(b.textContent))`);
  });
  // First click arms the confirm, second click removes.
  await alice.eval(`(() => {
    [...document.querySelectorAll('button')].find((b) => /Remove conversation/.test(b.textContent)).click();
    return true;
  })()`);
  await alice.waitFor("dm confirm step armed", () =>
    alice.eval(`[...document.querySelectorAll('button')].some((b) => /Click again to confirm/.test(b.textContent))`));
  await alice.eval(`(() => {
    [...document.querySelectorAll('button')].find((b) => /Click again to confirm/.test(b.textContent)).click();
    return true;
  })()`);

  const gone = await alice.waitFor("dm history deleted", async () => {
    const s = await dmState(alice, dmCode);
    return !s.room && s.contents.length === 0 ? s : null;
  });
  check.equal(gone, { room: false, contents: [] }, "room and history deleted");
  check.ok(
    !(await alice.json(`JSON.stringify(window.__awful.node()?.services.pubsub.getTopics() ?? [])`)).includes(`app:room:${dmCode}`),
    "dm topic unsubscribed"
  );
  check.ok(!(await alice.json(`JSON.stringify(window.__awful.state.inCall)`)), "call in the dm was hung up");

  // A NEW message from Bob recreates the thread - with only the new content.
  await bob.eval(`(async () => {
    const dids = [...window.__awful.peerIdToDid.values()];
    const m = await import('/src/lib/transport/dm.svelte.ts');
    await m.openDmConversation(dids[0]);
    return true;
  })()`);
  await bob.say("dm after removal");
  const reborn = await alice.waitFor("thread recreated", async () => {
    const s = await dmState(alice, dmCode);
    return s.contents.length > 0 ? s : null;
  });
  check.equal(reborn.contents, ["dm after removal"], "recreated with only the new message");
} finally {
  await closeAll([alice, bob]);
}

check.finish();
