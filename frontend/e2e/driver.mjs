/**
 * Multi-peer driver for awful.chat.
 *
 * Written after a long run of tests that failed for harness reasons rather
 * than app reasons, so the rules here are deliberate:
 *
 *   - No fixed sleeps. Everything waits on a condition with a deadline, so a
 *     slow relay makes a test slower, not wrong.
 *   - Every peer starts from wiped storage. Leftover rooms and DMs from an
 *     earlier run produced several confident, completely invalid results.
 *   - Rooms are opened through the app's own router, never by clicking a
 *     sidebar row: these profiles accumulate dozens of similarly named rooms
 *     and text matching picks the wrong one.
 *   - Sessions are always closed, or the next run dies with
 *     "Maximum number of active sessions".
 */

const APP = process.env.AWFUL_URL ?? "http://localhost:5175";

class Bidi {
  constructor(port) {
    this.port = port;
    this.id = 0;
    this.pending = new Map();
  }
  async open() {
    this.ws = new WebSocket(`ws://127.0.0.1:${this.port}/session`);
    this.ws.addEventListener("message", (e) => {
      const m = JSON.parse(e.data);
      if (!m.id || !this.pending.has(m.id)) return;
      const { res, rej } = this.pending.get(m.id);
      this.pending.delete(m.id);
      m.type === "error" ? rej(new Error(JSON.stringify(m).slice(0, 300))) : res(m.result);
    });
    await new Promise((r) => this.ws.addEventListener("open", r));
    await this.send("session.new", { capabilities: {} });
    const { contexts } = await this.send("browsingContext.getTree", {});
    this.context = contexts[0].context;
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((res, rej) => this.pending.set(id, { res, rej }));
  }
  async close() {
    try { await this.send("session.end", {}); } catch {}
    try { this.ws.close(); } catch {}
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A phone-shaped window. 390x844 is the iPhone 14 / Pixel class, and more to
 * the point it is under the app's own 640px breakpoint, which is what every
 * mobile branch in the UI keys off.
 *
 * What this does NOT do is emulate touch. Firefox's BiDi has no device
 * emulation, so `(pointer: coarse)` stays false and `ontouchstart` is absent:
 * a scenario here can test the layout a phone gets, not the input a phone
 * uses. Anything gated purely on a coarse pointer has to be tested by hand.
 */
const MOBILE_VIEWPORT = { width: 390, height: 844 };
const DESKTOP_VIEWPORT = { width: 1280, height: 900 };

export class Peer {
  constructor(port, name) {
    this.port = port;
    this.name = name;
    this.bidi = new Bidi(port);
  }

  async start({ wipe = true, mobile = false } = {}) {
    await this.bidi.open();
    this.mobile = mobile;
    await this.setViewport(mobile ? MOBILE_VIEWPORT : DESKTOP_VIEWPORT, {
      devicePixelRatio: mobile ? 3 : null,
    });
    await this.go("/app");
    if (wipe) {
      await this.wipe();
      await this.go("/app");
    }
    return this;
  }

  /**
   * Resize the window.
   *
   * devicePixelRatio is a separate parameter and older geckodrivers reject it,
   * so a failure there retries without it: the pixel ratio is cosmetic here
   * and the width is the part that matters.
   */
  async setViewport(viewport, { devicePixelRatio = null } = {}) {
    const params = { context: this.bidi.context, viewport };
    if (devicePixelRatio !== null) {
      try {
        await this.bidi.send("browsingContext.setViewport", {
          ...params,
          devicePixelRatio,
        });
        return;
      } catch {
        // Fall through to the plain resize.
      }
    }
    await this.bidi.send("browsingContext.setViewport", params);
  }

  async go(path) {
    await this.bidi.send("browsingContext.navigate", {
      context: this.bidi.context,
      url: APP + path,
      wait: "complete",
    });
    await this.unlockIfNeeded();
  }

  /**
   * A reload lands on the unlock screen unless the password was remembered,
   * which is exactly what a user sees after Ctrl+Shift+R. Get past it so a
   * scenario tests the app rather than the lock screen.
   */
  async unlockIfNeeded(password = "e2e-password") {
    const locked = await this.waitFor(
      "page settled",
      // Probe the DOM, not window.__awful: that global exists from module load
      // whether or not the identity is unlocked, so it reported "ready" while
      // the lock screen was still rendering and the unlock was skipped.
      () => this.eval(`(() => {
        const t = document.body.innerText;
        if (/Welcome back/i.test(t)) return 'locked';
        if (document.querySelector('input[placeholder="Room code, short code or link"]')) return 'ready';
        if (document.querySelector('textarea')) return 'ready';
        if (/Create new identity/i.test(t)) return 'ready';
        return false;
      })()`),
      { timeout: 30_000 }
    ).catch(() => false);
    if (locked !== "locked") return false;
    await this.fill("password", password);
    await this.waitFor("unlocked", async () => {
      await this.clickText("Unlock");
      return this.eval(`!/Welcome back/i.test(document.body.innerText)`);
    });
    return true;
  }

  /** Raw evaluate. Throws on page exceptions so failures are not silent. */
  async eval(expr) {
    const r = await this.bidi.send("script.evaluate", {
      expression: expr,
      target: { context: this.bidi.context },
      awaitPromise: true,
    });
    if (r.type === "exception") {
      throw new Error(`[${this.name}] ${String(r.exceptionDetails?.text).slice(0, 300)}`);
    }
    return r.result?.type === "null" ? null : r.result?.value;
  }

  async json(expr) {
    const raw = await this.eval(expr);
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  }

  /** Poll until `fn` returns something truthy, or fail with context. */
  async waitFor(label, fn, { timeout = 45_000, interval = 500 } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      try {
        last = await fn();
        if (last) return last;
      } catch (err) {
        last = String(err.message ?? err);
      }
      await sleep(interval);
    }
    // Dump what the page was actually showing: a bare timeout tells you
    // nothing and sends you chasing the wrong thing.
    let snapshot = "";
    try {
      snapshot = await this.eval(`JSON.stringify({
        path: location.pathname,
        buttons: [...document.querySelectorAll('button')].map(b => b.textContent.trim().slice(0, 24)).filter(Boolean).slice(0, 20),
        inputs: [...document.querySelectorAll('input')].map(i => i.placeholder).filter(Boolean),
        text: document.body.innerText.split(/[\\n\\t ]+/).join(' ').slice(0, 200),
      })`);
    } catch {}
    throw new Error(
      `[${this.name}] timed out waiting for ${label}\n  last: ${JSON.stringify(last)}\n  page: ${snapshot}`
    );
  }

  async wipe() {
    await this.eval(`(async () => {
      // Unregister the service worker and drop its caches FIRST. This is a
      // PWA, so without it the page happily serves a bundle from an earlier
      // run and the test measures code that is no longer in the repo.
      if (navigator.serviceWorker) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map(r => r.unregister()));
      }
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map(k => caches.delete(k)));
      }
      localStorage.clear();
      const dbs = await indexedDB.databases();
      await Promise.all(dbs.map(d => new Promise(res => {
        const req = indexedDB.deleteDatabase(d.name);
        req.onsuccess = req.onerror = req.onblocked = () => res();
      })));
      return true;
    })()`);
  }

  // ── UI helpers ────────────────────────────────────────────────────────────

  clickText(text) {
    return this.eval(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find(x => x.textContent.trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())}));
      if (b) b.click();
      return !!b;
    })()`);
  }

  clickLabel(label) {
    return this.eval(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find(x => (x.getAttribute('aria-label') || '') === ${JSON.stringify(label)});
      if (b) b.click();
      return !!b;
    })()`);
  }

  fill(placeholder, value) {
    return this.eval(`(() => {
      const el = document.querySelector('input[placeholder=' + ${JSON.stringify(JSON.stringify(placeholder))} + ']');
      if (!el) return false;
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(el, ${JSON.stringify(value)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
  }

  /** Create the identity and land in the app. */
  async signUp(displayName) {
    await this.waitFor("app shell", () => this.eval(`!!document.querySelector('button')`));
    await this.clickText("Got it");
    await this.waitFor("identity screen", async () => this.clickText("Create new identity"));
    await this.waitFor("password field", () => this.fill("password", "e2e-password"));
    await this.fill("confirm password", "e2e-password");
    await this.clickText("create identity");
    // The acknowledge control is a bits-ui checkbox backed by a hidden input,
    // so clicking the input does not flip it. Drive it until the button that
    // depends on it actually becomes enabled.
    await this.waitFor("mnemonic acknowledged", () => this.eval(`(() => {
      const btn = [...document.querySelectorAll('button')].find(x => /ready/i.test(x.textContent));
      if (btn && !btn.disabled) return true;
      const box = document.querySelector('[role=checkbox]') || document.querySelector('input[type=checkbox]');
      if (box) box.click();
      return false;
    })()`));
    await this.clickText("ready");
    await this.waitFor("profile step", () => this.fill("Your display name", displayName));
    await this.clickText("done");
    // The biometric step only appears when the platform offers it.
    await sleep(800);
    await this.clickText("skip for now");
    await this.waitFor("landing", () =>
      this.eval(`!!document.querySelector('input[placeholder="Room code, short code or link"]')`));
    await this.clickText("Got it");
    return this;
  }

  /** Create a room and enter it. Returns its code. */
  async createRoom(name) {
    // Creating from inside a room leaves the OLD roomCode set until the new
    // join lands - returning the first truthy value handed callers the wrong
    // room. Demand a code different from the one we started with.
    const before = await this.eval(`window.__awful?.state.roomCode ?? null`);
    if (before) {
      await this.clickLabel("Create or join room");
    }
    await this.waitFor("create form", () => this.fill("Room name (optional)", name));
    await this.waitFor("room created", async () => {
      await this.clickText("Create Room");
      return this.eval(`/Share this code/i.test(document.body.innerText)`);
    });
    // Retry the click: a single one can land before the handler is wired, and
    // the resulting "it just sat there" failure is indistinguishable from an
    // app bug.
    //
    // Two scenarios per full suite run used to die here, reporting "room
    // entered" against a page sitting on the room picker. The create flow had
    // been interrupted - a re-render, or a click landing somewhere stale - and
    // the loop went on clicking at a screen that had moved on. Clicking harder
    // cannot fix that, so notice it and start the flow again. No bail-out
    // count: waitFor's own deadline is the bound.
    return this.waitFor("room entered", async () => {
      const seen = await this.eval(`window.__awful?.state.roomCode ?? null`);
      if (seen && seen !== before) return seen;
      if (await this.eval(`/Share this code/i.test(document.body.innerText)`)) {
        // The share screen's own button, and the only one matching here.
        await this.clickText("Join Room");
        return null;
      }
      await this.clickLabel("Create or join room");
      await this.fill("Room name (optional)", name);
      await this.clickText("Create Room");
      return null;
    });
  }

  async joinRoom(code) {
    if (await this.eval(`!!window.__awful?.state.roomCode`)) {
      await this.clickLabel("Create or join room");
    }
    await this.waitFor("join field", () => this.fill("Room code, short code or link", code));
    return this.waitFor(`room ${code}`, async () => {
      if ((await this.eval(`window.__awful?.state.roomCode`)) === code) return true;
      await this.fill("Room code, short code or link", code);
      await this.clickText("Join Room");
      return false;
    });
  }

  /** Switch to an already-joined room via the router, not a sidebar click. */
  async openRoom(code) {
    await this.eval(`(() => {
      history.pushState({ roomCode: ${JSON.stringify(code)} }, '', '/r/' + ${JSON.stringify(code)});
      window.dispatchEvent(new PopStateEvent('popstate', { state: { roomCode: ${JSON.stringify(code)} } }));
      return true;
    })()`);
    return this.waitFor(`switch to ${code}`, async () =>
      (await this.eval(`window.__awful.state.roomCode`)) === code);
  }

  async say(text) {
    await this.waitFor("composer", () => this.eval(`!!document.querySelector('textarea')`));
    return this.eval(`(() => {
      const el = document.querySelector('textarea');
      const set = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      set.call(el, ${JSON.stringify(text)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()`);
  }

  // ── State readers ─────────────────────────────────────────────────────────

  state() {
    return this.json(`JSON.stringify({
      room: window.__awful.state.roomCode,
      roomName: window.__awful.state.roomName,
      mode: window.__awful.state.chatMode,
      peers: window.__awful.state.peers.length,
      bound: window.__awful.peerIdToDid.size,
      users: window.__awful.state.roomUsers.length,
      relay: window.__awful.state.relayConnected,
      inCall: window.__awful.state.inCall,
      callPeers: [...window.__awful.state.callPeerIds].length,
      messages: window.__awful.state.messages.map(m => m.content),
    })`);
  }

  /** What the voice layer holds: the call roster it was fed, and its links. */
  voice() {
    return this.json(
      `JSON.stringify(window.__awful.voice ? window.__awful.voice() : null)`
    );
  }

  selfId() {
    return this.eval(`window.__awful.selfId()`);
  }

  /** peerIds we can only reach through the relay's circuit. */
  relayed() {
    return this.json(`JSON.stringify(window.__awful.relayed())`);
  }

  videoConnected() {
    return this.eval(`window.__awful.video().connected`);
  }

  /** Everything stored for a room, independent of what is on screen. */
  stored(roomCode) {
    return this.json(`(async () => {
      const db = await new Promise((res, rej) => {
        const r = indexedDB.open('awful-chat');
        r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
      });
      const all = await new Promise(r => {
        const q = db.transaction('messages').objectStore('messages').getAll();
        q.onsuccess = () => r(q.result);
      });
      return JSON.stringify(all
        .filter(m => m.roomCode === ${JSON.stringify(roomCode)})
        .sort((a, b) => a.lamport - b.lamport || String(a.senderId).localeCompare(b.senderId))
        .map(m => m.content));
    })()`);
  }

  // ── Faults ────────────────────────────────────────────────────────────────

  faults(config) {
    return this.json(`JSON.stringify(window.__faults.set(${JSON.stringify(config)}))`);
  }
  clearFaults() {
    return this.eval(`window.__faults.clear()`);
  }
  stats() {
    return this.json(`JSON.stringify(window.__awful.stats)`);
  }
  transportStats() {
    return this.json(
      `JSON.stringify(window.__awful.transportStats ? window.__awful.transportStats() : {})`
    );
  }
  faultStats() {
    return this.json(`JSON.stringify(window.__faults.stats())`);
  }

  close() {
    return this.bidi.close();
  }
}

/** Boot N peers in parallel on consecutive debug ports. */
export async function bootPeers(
  names,
  { ports = [9307, 9308, 9309], mobile = false } = {}
) {
  const peers = names.map((n, i) => new Peer(ports[i], n));
  try {
    await Promise.all(peers.map((p) => p.start({ mobile })));
    await Promise.all(peers.map((p, i) => p.signUp(names[i])));
    return peers;
  } catch (err) {
    // Close on the way out, or the next run dies with "Maximum number of
    // active sessions" and the real error is buried under that.
    await closeAll(peers);
    throw err;
  }
}

export async function closeAll(peers) {
  await Promise.all(peers.map((p) => p.close().catch(() => {})));
}

export { sleep };
