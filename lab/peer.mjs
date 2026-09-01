/**
 * One browser, driving the real app.
 *
 * The UI flows are ported from `frontend/e2e/driver.mjs` rather than
 * reinvented: those selectors were paid for with a day of tests that failed
 * for harness reasons, and every rule they encode still applies here. What is
 * new is below the flows - this peer can be asked whether audio actually
 * ARRIVED, which is the one question the Firefox harness cannot answer.
 */
import { Cdp } from "./cdp.mjs";

const PASSWORD = "lab-password";

export class LabPeer extends Cdp {
  constructor(port, name, appUrl) {
    super(port);
    this.name = name;
    this.appUrl = appUrl;
  }

  async start({ wipe = true } = {}) {
    await this.open();
    // Before the first navigation: a connection built earlier than this is
    // invisible for the rest of the run.
    await this.installPcCapture();
    await this.goto(`${this.appUrl}/app`);
    if (wipe) {
      // A PWA serves the previous run's bundle otherwise, and the run then
      // measures code that is no longer in the repo.
      await this.eval(`(async () => {
        if (navigator.serviceWorker) {
          const regs = await navigator.serviceWorker.getRegistrations();
          await Promise.all(regs.map((r) => r.unregister()));
        }
        if (window.caches) {
          const keys = await caches.keys();
          await Promise.all(keys.map((k) => caches.delete(k)));
        }
        localStorage.clear();
        const dbs = await indexedDB.databases();
        await Promise.all(dbs.map((d) => new Promise((res) => {
          const req = indexedDB.deleteDatabase(d.name);
          req.onsuccess = req.onerror = req.onblocked = () => res();
        })));
        return true;
      })()`);
      await this.goto(`${this.appUrl}/app`);
    }
    return this;
  }

  clickText(text) {
    return this.eval(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => x.textContent.trim().toLowerCase().includes(${JSON.stringify(text.toLowerCase())}));
      if (b) b.click();
      return !!b;
    })()`);
  }

  clickLabel(label) {
    return this.eval(`(() => {
      const b = [...document.querySelectorAll('button')]
        .find((x) => (x.getAttribute('aria-label') || '') === ${JSON.stringify(label)});
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

  async signUp(displayName) {
    await this.waitFor("app shell", `!!document.querySelector('button')`);
    await this.clickText("Got it");
    await this.waitFor("identity screen", `(() => {
      const b = [...document.querySelectorAll('button')].find((x) => /create new identity/i.test(x.textContent));
      if (b) b.click();
      return !!b;
    })()`);
    await this.waitFor("password field", `(() => {
      const el = document.querySelector('input[placeholder*="password" i]');
      if (!el) return false;
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      for (const input of document.querySelectorAll('input[type=password]')) {
        set.call(input, ${JSON.stringify(PASSWORD)});
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
      return true;
    })()`);
    await this.clickText("create identity");
    await this.waitFor("mnemonic acknowledged", `(() => {
      const btn = [...document.querySelectorAll('button')].find((x) => /ready/i.test(x.textContent));
      if (btn && !btn.disabled) return true;
      const box = document.querySelector('[role=checkbox]') || document.querySelector('input[type=checkbox]');
      if (box) box.click();
      return false;
    })()`);
    await this.clickText("ready");
    await this.waitFor("profile step", `(() => {
      const el = document.querySelector('input[placeholder="Your display name"]');
      if (!el) return false;
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(el, ${JSON.stringify(displayName)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await this.clickText("done");
    await this.waitFor("past the biometric step", `(() => {
      if (document.querySelector('input[placeholder="Room code, short code or link"]')) return true;
      const b = [...document.querySelectorAll('button')].find((x) => /skip for now/i.test(x.textContent));
      if (b) b.click();
      return false;
    })()`);
    await this.clickText("Got it");
    return this;
  }

  async createRoom(name) {
    await this.waitFor("create form", `(() => {
      const el = document.querySelector('input[placeholder="Room name (optional)"]');
      if (!el) return false;
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(el, ${JSON.stringify(name)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    await this.waitFor("room created", `(() => {
      if (/Share this code/i.test(document.body.innerText)) return true;
      const b = [...document.querySelectorAll('button')].find((x) => /create room/i.test(x.textContent));
      if (b) b.click();
      return false;
    })()`);
    // The URL is the room, on every build. window.__awful is DEV-only and is
    // simply absent on a deployed instance.
    return this.waitFor("room entered", `(() => {
      const m = location.pathname.match(/^\\/r\\/([^/]+)/);
      if (m) return decodeURIComponent(m[1]);
      const b = [...document.querySelectorAll('button')].find((x) => /join room/i.test(x.textContent));
      if (b) b.click();
      return null;
    })()`);
  }

  async joinRoom(code) {
    await this.waitFor("join field", `(() => {
      const el = document.querySelector('input[placeholder="Room code, short code or link"]');
      if (!el) return false;
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
      set.call(el, ${JSON.stringify(code)});
      el.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()`);
    return this.waitFor(`room ${code}`, `(() => {
      if (location.pathname.toUpperCase().includes(${JSON.stringify(code.toUpperCase())})) return true;
      const b = [...document.querySelectorAll('button')].find((x) => /join room/i.test(x.textContent));
      if (b) b.click();
      return false;
    })()`, { timeout: 60_000 });
  }

  /**
   * The three helpers below read `window.__awful`, which exists only in a DEV
   * build. They return null against a deployed instance rather than throwing,
   * so a scenario can use them for extra detail without becoming Mode A only.
   */
  selfId() {
    return this.eval(`window.__awful ? window.__awful.selfId() : null`);
  }

  voice() {
    return this.eval(
      `window.__awful ? JSON.stringify(window.__awful.voice()) : "null"`
    ).then(JSON.parse);
  }

  async joinCall() {
    // "Leave call" only exists once the call is joined, on every build.
    await this.waitFor("in call", `(() => {
      const has = (label) => [...document.querySelectorAll('button')]
        .some((x) => (x.getAttribute('aria-label') || '') === label);
      if (has('Leave call')) return true;
      const b = [...document.querySelectorAll('button')]
        .find((x) => (x.getAttribute('aria-label') || '') === 'Join call');
      if (b) b.click();
      return false;
    })()`, { timeout: 60_000 });
    return this;
  }

  /**
   * Did audio actually arrive at this browser?
   *
   * Read from every RTCPeerConnection the page built, so it needs no app
   * handle and works against a deployed build. Bytes are summed across
   * connections: which one carries the voice is an implementation detail, and
   * "any audio at all" is the question a listener would ask.
   */
  media() {
    return this.eval(`(async () => {
      const out = { pcs: 0, live: 0, audioBytes: 0, relayed: false, path: null, rtt: null };
      for (const pc of (window.__labPcs || [])) {
        out.pcs++;
        if (pc.connectionState === "closed") continue;
        out.live++;
        let stats;
        try { stats = await pc.getStats(); } catch (e) { continue; }
        const cands = {};
        let best = null;
        for (const r of stats.values()) {
          if (r.type === "inbound-rtp" && r.kind === "audio") out.audioBytes += (r.bytesReceived || 0);
          if (r.type === "local-candidate" || r.type === "remote-candidate") cands[r.id] = r;
          if (r.type === "candidate-pair" && r.state === "succeeded" && (!best || r.nominated)) best = r;
        }
        if (best) {
          const t = (inline, id) => inline || (cands[id] && cands[id].candidateType) || "?";
          const l = t(best.localCandidateType, best.localCandidateId);
          const rm = t(best.remoteCandidateType, best.remoteCandidateId);
          if (!out.path) {
            out.path = l + "/" + rm;
            out.rtt = Math.round((best.currentRoundTripTime || 0) * 1000);
          }
          if (l === "relay" || rm === "relay") out.relayed = true;
        }
      }
      return JSON.stringify(out);
    })()`).then(JSON.parse);
  }

  /** The recorder's whole ring, which is how the lab reads media truth. */
  diag() {
    return this.eval(
      `window.__awful ? JSON.stringify(window.__awful.diag()) : "null"`
    ).then(JSON.parse);
  }

  /**
   * Did audio actually arrive at this browser?
   *
   * Read from every RTCPeerConnection the page built, so it needs no app
   * handle and works against a deployed build. Bytes are summed across
   * connections: which one carries the voice is an implementation detail, and
   * "any audio at all" is the question a listener would ask.
   */
  media() {
    return this.eval(`(async () => {
      const out = { pcs: 0, live: 0, audioBytes: 0, relayed: false, path: null, rtt: null };
      for (const pc of (window.__labPcs || [])) {
        out.pcs++;
        if (pc.connectionState === "closed") continue;
        out.live++;
        let stats;
        try { stats = await pc.getStats(); } catch (e) { continue; }
        const cands = {};
        let best = null;
        for (const r of stats.values()) {
          if (r.type === "inbound-rtp" && r.kind === "audio") out.audioBytes += (r.bytesReceived || 0);
          if (r.type === "local-candidate" || r.type === "remote-candidate") cands[r.id] = r;
          if (r.type === "candidate-pair" && r.state === "succeeded" && (!best || r.nominated)) best = r;
        }
        if (best) {
          const t = (inline, id) => inline || (cands[id] && cands[id].candidateType) || "?";
          const l = t(best.localCandidateType, best.localCandidateId);
          const rm = t(best.remoteCandidateType, best.remoteCandidateId);
          if (!out.path) {
            out.path = l + "/" + rm;
            out.rtt = Math.round((best.currentRoundTripTime || 0) * 1000);
          }
          if (l === "relay" || rm === "relay") out.relayed = true;
        }
      }
      return JSON.stringify(out);
    })()`).then(JSON.parse);
  }

  /** The recorder's whole ring, which is how the lab reads media truth. */
  diag() {
    return this.eval(
      `window.__awful ? JSON.stringify(window.__awful.diag()) : "null"`
    ).then(JSON.parse);
  }
}
