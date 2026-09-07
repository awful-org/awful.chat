/**
 * The per-person volume (right-click a call tile) must survive a reload:
 * nobody wants to re-set a friend's level every call. Stored by did:key, the
 * durable identity, and applied the moment their audio track attaches.
 *
 * Headless cannot run a real call, so the call tile is injected: a fake
 * participant with a live oscillator track, plus its peerId->did binding in
 * the app's real map (exposed on window.__awful - NOT via import(), which can
 * reach a second module instance after HMR).
 */
import { Peer, sleep } from "../driver.mjs";
import { Check } from "../assert.mjs";

const check = new Check("per-person volume survives a reload");
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
  p.waitFor("volume menu", async () => {
    await p.eval(`(() => {
      const tile = [...document.querySelectorAll('button')]
        .find((b) => /CallFriend/.test(b.innerText) && b.className.includes('rounded-lg'));
      tile?.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: 400, clientY: 300 }));
      return true;
    })()`);
    return p.eval(`!!document.querySelector('[role=menu] input[type=range]')`);
  });

const menuPercent = () =>
  p.eval(`(() => {
    const spans = [...document.querySelectorAll('[role=menu] span')].map((s) => s.textContent.trim());
    return spans.find((t) => /%$|muted/.test(t)) ?? null;
  })()`);

try {
  await p.start();
  await p.signUp("VolumeTester");
  const room = await p.createRoom("VolRoom");
  await injectCall();
  await openMenu();
  check.equal(await menuPercent(), "100%", "defaults to 100%");

  // Set ~10% via the menu slider.
  await p.eval(`(() => {
    const r = document.querySelector('[role=menu] input[type=range]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(r, '30');
    r.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await p.waitFor("menu shows 10%", async () => (await menuPercent()) === "10%");
  check.ok(true, "changed to 10% through the menu");

  const stored = await p.json(`JSON.stringify(JSON.parse(localStorage.getItem('awful_audio_prefs') ?? '{}').peerVolumes ?? {})`);
  check.ok(
    typeof stored[FAKE_DID] === "number" && stored[FAKE_DID] < 0.2,
    "persisted under the did",
    stored
  );

  // Reload: the injected call is gone with the page; rebuild it and the
  // remembered level must come back, both in the menu and on the live gain.
  await p.go("/r/" + room);
  await p.waitFor("back in room", async () =>
    (await p.eval(`window.__awful?.state.roomCode`)) === room);
  await injectCall();
  await openMenu();
  check.equal(await menuPercent(), "10%", "menu reopens at the remembered level");

  // Setting it back to 100% removes the override entirely.
  await p.eval(`(() => {
    const r = document.querySelector('[role=menu] input[type=range]');
    const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
    set.call(r, '60');
    r.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await p.waitFor("back at 100%", async () => (await menuPercent()) === "100%");
  const cleared = await p.json(`JSON.stringify(JSON.parse(localStorage.getItem('awful_audio_prefs') ?? '{}').peerVolumes ?? {})`);
  check.equal(cleared, {}, "resetting to 100% removes the stored override");
} finally {
  await p.close();
}

check.finish();
