/**
 * A Chrome DevTools Protocol client, small enough to read in one sitting.
 *
 * The e2e harness next door speaks WebDriver BiDi to Firefox. The lab speaks
 * CDP to Chrome for one reason: Firefox headless never completes an ICE
 * handshake in that harness (see the note in `e2e/scenarios/call-join-speed.mjs`),
 * so every voice and SFU test it has asserts signalling counters and never
 * once asserts that audio arrived. A lab that cannot carry media cannot test
 * the two things that break in production.
 */

const CDP_TIMEOUT_MS = 30_000;

export class Cdp {
  #ws = null;
  #id = 0;
  #pending = new Map();
  #sessionId = null;

  constructor(port, host = "127.0.0.1") {
    this.port = port;
    this.host = host;
  }

  /** Find the browser's websocket, then attach to its first page target. */
  async open() {
    const res = await fetch(`http://${this.host}:${this.port}/json/version`);
    const { webSocketDebuggerUrl } = await res.json();
    this.#ws = new WebSocket(webSocketDebuggerUrl);
    this.#ws.addEventListener("message", (e) => this.#onMessage(e));
    await new Promise((resolve, reject) => {
      this.#ws.addEventListener("open", resolve, { once: true });
      this.#ws.addEventListener("error", reject, { once: true });
    });

    const { targetInfos } = await this.send("Target.getTargets");
    const page = targetInfos.find((t) => t.type === "page");
    if (!page) throw new Error("no page target");
    const { sessionId } = await this.send("Target.attachToTarget", {
      targetId: page.targetId,
      flatten: true,
    });
    this.#sessionId = sessionId;
    await this.send("Runtime.enable");
    await this.send("Page.enable");
    // Headless defaults to 800x600, which is a phone as far as this app's
    // layout is concerned: the member list and half the call controls never
    // render, and a scenario then "cannot see" a peer who is present. Desktop
    // is what the flows were written against.
    await this.send("Emulation.setDeviceMetricsOverride", {
      width: 1600,
      height: 1000,
      deviceScaleFactor: 1,
      mobile: false,
    });
    return this;
  }

  #onMessage(e) {
    const msg = JSON.parse(e.data);
    if (!msg.id) return; // an event, not a reply
    const waiting = this.#pending.get(msg.id);
    if (!waiting) return;
    this.#pending.delete(msg.id);
    if (msg.error) waiting.reject(new Error(JSON.stringify(msg.error).slice(0, 400)));
    else waiting.resolve(msg.result);
  }

  send(method, params = {}) {
    const id = ++this.#id;
    const frame = { id, method, params };
    // Every call after the attach is scoped to the page session.
    if (this.#sessionId && method !== "Target.attachToTarget") {
      frame.sessionId = this.#sessionId;
    }
    this.#ws.send(JSON.stringify(frame));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, CDP_TIMEOUT_MS);
      this.#pending.set(id, {
        resolve: (v) => (clearTimeout(timer), resolve(v)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      });
    });
  }

  /**
   * Capture every RTCPeerConnection the page creates, before it creates any.
   *
   * The lab must be able to say whether audio ARRIVED, and the only honest
   * source for that is the connection itself. `window.__awful` cannot be it:
   * that handle is `import.meta.env.DEV` only, so it does not exist on any
   * deployed build - which is precisely where the interesting failures are.
   * Wrapping the constructor needs no cooperation from the app, works
   * identically on a dev server and on production, and is the same trick the
   * app's own PeerConnection census uses.
   */
  async installPcCapture() {
    await this.send("Page.addScriptToEvaluateOnNewDocument", {
      source: `(() => {
        if (window.__labPcs) return;
        const Native = window.RTCPeerConnection;
        if (typeof Native !== "function") return;
        const list = [];
        window.__labPcs = list;
        class Captured extends Native {
          constructor(...args) {
            super(...args);
            try { list.push(this); } catch (e) {}
          }
        }
        window.RTCPeerConnection = Captured;
        // Uncaught throws too, from the same shim and for the same reason: on
        // a deployed build there is no app handle to read them from, and an
        // exception nobody caught is the most valuable event in a run.
        window.__labErrs = [];
        addEventListener("error", (e) => {
          try { window.__labErrs.push(String((e.error && e.error.message) || e.message)); } catch (x) {}
        });
        addEventListener("unhandledrejection", (e) => {
          try {
            const r = e.reason;
            window.__labErrs.push("rejection: " + String((r && r.message) || r));
          } catch (x) {}
        });
      })()`,
    });
  }

  async goto(url) {
    const res = await this.send("Page.navigate", { url });
    // Wait for the document rather than a fixed sleep, the same rule the e2e
    // driver follows: a slow container makes a run slower, not wrong.
    await this.waitFor("document ready", `document.readyState === "complete"`);
    // A navigation that failed leaves the browser on chrome-error://, where
    // every later step fails in some unrelated way - the first symptom was a
    // localStorage exception three calls downstream. Chrome does not always
    // set errorText, so the URL is checked too. This must be loud: a target
    // that did not load is not a fault in the app being tested.
    const landed = await this.eval(`location.href`);
    if (res.errorText || String(landed).startsWith("chrome-error://")) {
      throw new Error(
        `UNREACHABLE: ${url} did not load (${res.errorText ?? landed})`
      );
    }
  }

  /**
   * Evaluate an expression and return its value. Promises are awaited, so a
   * caller can hand this an async IIFE and get the resolved value back.
   */
  async eval(expression) {
    const { result, exceptionDetails } = await this.send("Runtime.evaluate", {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (exceptionDetails) {
      const text =
        exceptionDetails.exception?.description ??
        exceptionDetails.text ??
        "page threw";
      throw new Error(String(text).slice(0, 500));
    }
    return result.value;
  }

  /** Poll an expression until it is truthy. No fixed sleeps anywhere. */
  async waitFor(label, expression, { timeout = 30_000, interval = 250 } = {}) {
    const deadline = Date.now() + timeout;
    let last;
    for (;;) {
      try {
        last = await this.eval(expression);
        if (last) return last;
      } catch (err) {
        last = `threw: ${err.message}`;
      }
      if (Date.now() > deadline) {
        throw new Error(`timed out waiting for ${label} (last: ${JSON.stringify(last)?.slice(0, 200)})`);
      }
      await new Promise((r) => setTimeout(r, interval));
    }
  }

  close() {
    try {
      this.#ws?.close();
    } catch {
      // Nothing left to do about it.
    }
  }
}
