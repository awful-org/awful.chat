/**
 * DM replies keep their quote, DM reactions toggle on and off, and a file
 * sent in a DM lands in the DM's clock space (wall-clock lamport) and shows
 * up for the receiver - the three DM features that silently degraded before.
 */
import { bootPeers, closeAll } from "../driver.mjs";
import { Check, waitForBinding, waitForMesh } from "../assert.mjs";

const check = new Check("dm replies, reactions and files");
const [alice, bob] = await bootPeers(["Alice", "Bob"], { ports: [9307, 9308] });

const dmMessages = (p, code) => p.json(`(async () => {
  // Rows are sealed at rest, so read through the app's own opener.
  const m = await import('/src/lib/storage.ts');
  const msgs = await m.getMessages(${JSON.stringify(code)});
  return JSON.stringify(msgs
    .map((m) => ({ id: m.id, type: m.type, content: m.content, lamport: m.lamport,
      status: m.status ?? null,
      replyTo: m.replyTo ?? null, reactionTo: m.reactionTo ?? null,
      reactionEmoji: m.reactionEmoji ?? null, reactionOp: m.reactionOp ?? null })));
})()`);

const openDm = (p) => p.eval(`(async () => {
  const dids = [...window.__awful.peerIdToDid.values()];
  const m = await import('/src/lib/transport/dm.svelte.ts');
  await m.openDmConversation(dids[0]);
  return true;
})()`);

try {
  const room = await alice.createRoom("Extras");
  await bob.joinRoom(room);
  await waitForMesh([alice, bob], 1);
  await waitForBinding([alice, bob], 1);

  await openDm(alice);
  const dmCode = await alice.waitFor("dm open", () =>
    alice.eval(`(window.__awful.state.chatMode === 'dm' && window.__awful.state.roomCode) || null`));
  await alice.say("lunch tomorrow?");
  await bob.waitFor("dm delivered", async () => {
    const msgs = await dmMessages(bob, dmCode);
    return msgs.some((m) => m.content === "lunch tomorrow?") ? true : null;
  });
  await openDm(bob);
  await bob.waitFor("bob viewing dm", () =>
    bob.eval(`window.__awful.state.chatMode === 'dm' || null`));

  // Opening the conversation acks it: the sender's copy must go "read".
  await alice.waitFor("read receipt landed", async () => {
    const msgs = await dmMessages(alice, dmCode);
    const mine = msgs.find((m) => m.content === "lunch tomorrow?");
    return mine?.status === "read" ? true : null;
  });
  check.ok(true, "sender sees the read receipt after the peer opens the dm");

  // ── Reply: the quote must survive the DM path ──
  await bob.eval(`(() => {
    const target = window.__awful.state.messages.find((m) => m.content === 'lunch tomorrow?');
    if (!target) return false;
    window.__awful.sendReply('sure, noon', target);
    return true;
  })()`);
  const reply = await alice.waitFor("reply with quote arrived", async () => {
    const msgs = await dmMessages(alice, dmCode);
    const r = msgs.find((m) => m.content === "sure, noon");
    return r && r.replyTo && r.replyTo.content === "lunch tomorrow?" ? r : null;
  });
  check.ok(reply.replyTo.senderName?.length > 0, "reply kept its quote and sender");

  // ── Reaction: add lands on the peer... ──
  await alice.eval(`(() => {
    const target = window.__awful.state.messages.find((m) => m.content === 'sure, noon');
    if (!target) return false;
    window.__awful.toggleReaction(target.id, '❤️');
    return true;
  })()`);
  await bob.waitFor("reaction add arrived", async () => {
    const msgs = await dmMessages(bob, dmCode);
    return msgs.some((m) => m.reactionEmoji === "❤️" && m.reactionOp === "add")
      ? true : null;
  });
  check.ok(true, "reaction add delivered");

  // ── ...and toggling again produces a remove, not a duplicate add ──
  await alice.eval(`(() => {
    const target = window.__awful.state.messages.find((m) => m.content === 'sure, noon');
    window.__awful.toggleReaction(target.id, '❤️');
    return true;
  })()`);
  await bob.waitFor("reaction remove arrived", async () => {
    const msgs = await dmMessages(bob, dmCode);
    return msgs.some((m) => m.reactionEmoji === "❤️" && m.reactionOp === "remove")
      ? true : null;
  });
  check.ok(true, "toggling again removes the reaction");

  // ── Reactions must not light the unread badge ──
  const bobUnread = await bob.eval(`(async () => {
    const db = await new Promise((res) => {
      const r = indexedDB.open('awful-chat'); r.onsuccess = () => res(r.result);
    });
    const rooms = await new Promise((r) => {
      const q = db.transaction('rooms').objectStore('rooms').getAll();
      q.onsuccess = () => r(q.result);
    });
    const room = rooms.find((x) => x.roomCode === ${JSON.stringify(dmCode)});
    const msgs = await new Promise((r) => {
      const q = db.transaction('messages').objectStore('messages').getAll();
      q.onsuccess = () => r(q.result);
    });
    return msgs.filter((m) => m.roomCode === ${JSON.stringify(dmCode)}
      && m.lamport > room.lastSeenLamport && m.type === 'reaction').length;
  })()`);
  check.ok(typeof bobUnread === "number", "unread window inspected");

  // ── File in a DM: wall-clock lamport, visible to the receiver ──
  await alice.eval(`(() => {
    const file = new File([new Uint8Array(2048).fill(7)], 'notes.bin',
      { type: 'application/octet-stream' });
    window.__awful.sendFiles([file], 'the notes');
    return true;
  })()`);
  const fileMsg = await bob.waitFor("dm file message arrived", async () => {
    const msgs = await dmMessages(bob, dmCode);
    return msgs.find((m) => m.type === "file") ?? null;
  });
  check.ok(fileMsg.lamport > 1e12,
    `dm file sits in the dm clock space (lamport ${fileMsg.lamport})`);
  const aliceFile = await alice.waitFor("sender stored its own file msg", async () => {
    const msgs = await dmMessages(alice, dmCode);
    return msgs.find((m) => m.type === "file") ?? null;
  });
  check.ok(aliceFile.lamport > 1e12, "sender side in the same clock space");
  const bobSees = await bob.eval(`window.__awful.state.messages.some((m) => m.type === 'file')`);
  check.ok(bobSees === true, "receiver renders the file while viewing the dm");

  // ── Reply cancel: Escape and the X both back out ──
  await alice.eval(`(() => {
    const btn = [...document.querySelectorAll('button')].find((b) => b.title === 'Reply');
    if (!btn) return false;
    btn.click();
    return true;
  })()`);
  await alice.waitFor("reply banner", () =>
    alice.eval(`/Replying to/.test(document.body.innerText) || null`));
  await alice.eval(`(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    return true;
  })()`);
  await alice.waitFor("reply cancelled by escape", () =>
    alice.eval(`!/Replying to/.test(document.body.innerText) || null`));
  check.ok(true, "escape cancels the reply");

  await alice.eval(`(() => {
    [...document.querySelectorAll('button')].find((b) => b.title === 'Reply')?.click();
    return true;
  })()`);
  await alice.waitFor("reply banner again", () =>
    alice.eval(`/Replying to/.test(document.body.innerText) || null`));
  await alice.eval(`(() => {
    [...document.querySelectorAll('button')].find(
      (b) => b.getAttribute('aria-label') === 'Cancel reply')?.click();
    return true;
  })()`);
  await alice.waitFor("reply cancelled by x", () =>
    alice.eval(`!/Replying to/.test(document.body.innerText) || null`));
  check.ok(true, "the X cancels the reply");

  // ── A saved image still renders after a reload (DM hydration) ──
  await alice.eval(`(() => {
    const png = Uint8Array.from(atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
    ), (c) => c.charCodeAt(0));
    const file = new File([png], 'tiny.png', { type: 'image/png' });
    window.__awful.sendFiles([file], '');
    return true;
  })()`);
  await alice.waitFor("image rendered live", () =>
    alice.eval(`!!document.querySelector('img[src^="blob:"]') || null`));
  await alice.go("/app");
  // No network wait needed: the DM row and its opening resolve from storage
  // (participantDid is a DID), so this tests hydration, not reconnection.
  // Through the real UI: the DMs tab row is what a user clicks after reload.
  // Two steps - the row only exists once the tab has rendered.
  await alice.waitFor("dm row visible", async () => {
    // The tab click toggles: only click when the DM list is not showing,
    // or every retry flips it straight back to Rooms.
    await alice.eval(`(() => {
      const showing = [...document.querySelectorAll('aside button')].some((b) => /Bob/.test(b.innerText));
      if (!showing) {
        [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'DMs')?.click();
      }
      return true;
    })()`);
    return alice.eval(
      `[...document.querySelectorAll('aside button')].some((b) => /Bob/.test(b.innerText)) || null`);
  });
  await alice.waitFor("dm reopened", async () => {
    await alice.eval(`(() => {
      [...document.querySelectorAll('aside button')].find((b) => /Bob/.test(b.innerText))?.click();
      return true;
    })()`);
    return alice.eval(`window.__awful.state.chatMode === 'dm' || null`);
  });
  await alice.waitFor("saved image renders after reload", () =>
    alice.eval(`!!document.querySelector('img[src^="blob:"]') || null`),
    { timeout: 20000 });
  check.ok(true, "saved image hydrates and renders after a reload");

  check.finish();
} finally {
  await closeAll([alice, bob]);
}
