/**
 * Right-click on a person's call tile offers the person, not just the
 * stream: Mute (the slider at 0 with a name, Unmute brings the old level
 * back), View profile, and Add to / Remove from phonebook.
 *
 * Headless cannot run a real call, so the tile is injected the way
 * peer-volume.mjs does it.
 */
import { Peer } from "../driver.mjs";
import { Check } from "../assert.mjs";

const check = new Check("call tile menu offers the person");
const p = new Peer(9307, "A");
const FAKE_PEER = "12D3KooWFakeCallPeerAAA";
const FAKE_DID = "did:key:z6MkFakeCallFriend";

const injectCall = async () => {
  await p.eval(`(() => {
    const s = window.__awful.state;
    const ctx = new AudioContext();
    const osc = ctx.createOscillator();
    const dest = ctx.createMediaStreamDestination();
    osc.connect(dest); osc.start();
    window.__awful.peerIdToDid.set(${JSON.stringify(FAKE_PEER)}, ${JSON.stringify(FAKE_DID)});
    s.peerNames = new Map([[${JSON.stringify(FAKE_DID)}, "CallFriend"]]);
    s.participants = new Map([[${JSON.stringify(FAKE_PEER)}, {
      peerId: ${JSON.stringify(FAKE_PEER)},
      audioTrack: dest.stream.getAudioTracks()[0],
      videoTrack: null, screenTrack: null, screenAudioTrack: null,
    }]]);
    s.callPeerIds = new Set([${JSON.stringify(FAKE_PEER)}]);
    // The stage shows only the call of the room on screen.
    s.callPeerRooms = new Map([[${JSON.stringify(FAKE_PEER)}, s.roomCode]]);
    s.callRoomCode = s.roomCode; s.inCall = true;
    return true;
  })()`);
};

const openMenu = () =>
  p.waitFor("tile menu", async () => {
    await p.eval(`(() => {
      const tile = [...document.querySelectorAll('button')]
        .find((b) => /CallFriend/.test(b.innerText) && b.className.includes('rounded-lg'));
      tile?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 300 }));
      return true;
    })()`);
    return p.eval(`!!document.querySelector('[role=menu] input[type=range]')`);
  });

const menuItems = () =>
  p.json(`JSON.stringify([...document.querySelectorAll('[role=menu] button')].map((b) => b.textContent.trim()))`);

const menuPercent = () =>
  p.eval(`(() => {
    const spans = [...document.querySelectorAll('[role=menu] span')].map((s) => s.textContent.trim());
    return spans.find((t) => /%$|muted/.test(t)) ?? null;
  })()`);

/** Exact label: "Mute" must not hit "Unmute" or the bar's "Mute microphone". */
const clickItem = (label) =>
  p.eval(`(() => {
    const b = [...document.querySelectorAll('[role=menu] button')]
      .find((x) => x.textContent.trim() === ${JSON.stringify(label)});
    if (b) b.click();
    return !!b;
  })()`);

const setSlider = (value) =>
  p.eval(`(() => {
    const r = document.querySelector('[role=menu] input[type=range]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(r, ${JSON.stringify(String(value))});
    r.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);

try {
  await p.start();
  await p.signUp("MenuTester");
  await p.createRoom("MenuRoom");
  await injectCall();

  await openMenu();
  const items = await menuItems();
  check.ok(items.includes("Mute"), "offers Mute", items);
  check.ok(items.includes("View profile"), "offers View profile", items);
  check.ok(items.includes("Add to phonebook"), "offers Add to phonebook", items);

  // Set 10%, then Mute: Unmute must bring the 10% back, not 100%.
  await setSlider(30);
  await p.waitFor("menu shows 10%", async () => (await menuPercent()) === "10%");
  check.ok(await clickItem("Mute"), "clicked Mute");
  await openMenu();
  check.equal(await menuPercent(), "muted", "muted after Mute");
  check.ok((await menuItems()).includes("Unmute"), "row flipped to Unmute");
  check.ok(await clickItem("Unmute"), "clicked Unmute");
  await openMenu();
  check.equal(await menuPercent(), "10%", "Unmute restores the level from before");
  // Dragging the slider to 0 flips the row in place, no reopen needed.
  await setSlider(0);
  await p.waitFor("row flips live", async () => (await menuItems()).includes("Unmute"));
  check.ok(true, "slider at 0 flips the row to Unmute in place");
  await clickItem("Unmute");

  // Phonebook, both ways.
  await openMenu();
  check.ok(await clickItem("Add to phonebook"), "clicked Add to phonebook");
  await p.waitFor("in phonebook", async () => {
    await openMenu();
    return (await menuItems()).includes("Remove from phonebook");
  });
  check.ok(true, "row flipped to Remove from phonebook");
  await clickItem("Remove from phonebook");
  await p.waitFor("out of phonebook", async () => {
    await openMenu();
    return (await menuItems()).includes("Add to phonebook");
  });
  check.ok(true, "and back to Add to phonebook");

  // Profile card.
  check.ok(await clickItem("View profile"), "clicked View profile");
  await p.waitFor("profile card", () =>
    p.eval(`(() => {
      const d = document.querySelector('[role=dialog]');
      return d && /CallFriend/.test(d.innerText) ? true : null;
    })()`));
  check.ok(true, "profile card opens for the person");
} finally {
  await p.close();
}

check.finish();
