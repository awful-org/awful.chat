import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { watchPwaUpdate, workerBuildId } from "./pwa-update";

class Worker extends EventTarget {
  state = "installed";
  postMessage = vi.fn();
}

function setup(id: string | null = "new", running = "current") {
  const worker = new Worker();
  const registration = Object.assign(new EventTarget(), {
    waiting: worker as Worker | null,
    installing: null as Worker | null,
    update: vi.fn().mockResolvedValue(undefined),
  });
  const container = new EventTarget();
  const show = vi.fn();
  const query = vi.fn().mockResolvedValue(id);
  const watcher = watchPwaUpdate(
    registration as unknown as ServiceWorkerRegistration,
    running, show, container as ServiceWorkerContainer, query,
  );
  return { worker, registration, container, show, query, watcher };
}

async function settle() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("navigator", { onLine: true });
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("update prompt build gating", () => {
  it("hides a waiting worker matching the running page, regardless of the controller", async () => {
    const { show, watcher } = setup("current");
    await settle();
    expect(show).not.toHaveBeenCalledWith(true);
    expect(watcher.isCurrent()).toBe(false);
    watcher.dispose();
  });

  it.each([["new", "current"], [null, "current"], ["", "current"], ["new", ""]])(
    "offers a different build or deliberately falls back for unknown identities (%s, %s)",
    async (id, running) => {
      const { show, watcher } = setup(id, running);
      await settle();
      expect(show).toHaveBeenLastCalledWith(true);
      expect(watcher.isCurrent()).toBe(true);
      watcher.dispose();
    },
  );

  it("ignores an old response after a new worker replaces it", async () => {
    const { registration, show, query, watcher } = setup("current");
    await settle();
    let reply!: (id: string) => void;
    query.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
    watcher.refresh();
    registration.waiting = new Worker();
    registration.dispatchEvent(new Event("updatefound"));
    await settle();
    reply("different");
    await settle();
    expect(show).not.toHaveBeenCalledWith(true);
    watcher.dispose();
  });

  it("ignores responses for workers that disappeared or activated", async () => {
    const { worker, registration, query, show, watcher } = setup("current");
    await settle();
    let reply!: (id: string) => void;
    query.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
    watcher.refresh();
    worker.state = "activated";
    registration.waiting = null;
    reply("different");
    await settle();
    expect(show).not.toHaveBeenCalledWith(true);
    expect(watcher.isCurrent()).toBe(false);
    watcher.dispose();
  });

  it("discovers a newly installed worker and clears the prompt on activation", async () => {
    const { registration, container, worker, show, watcher } = setup();
    registration.waiting = null;
    worker.state = "installing";
    registration.installing = worker;
    registration.dispatchEvent(new Event("updatefound"));
    await settle();
    expect(show).not.toHaveBeenCalledWith(true);
    registration.waiting = worker;
    worker.state = "installed";
    worker.dispatchEvent(new Event("statechange"));
    await settle();
    expect(show).toHaveBeenLastCalledWith(true);
    registration.waiting = null;
    container.dispatchEvent(new Event("controllerchange"));
    expect(show).toHaveBeenLastCalledWith(false);
    watcher.dispose();
  });

  it("keeps a dismissed worker hidden but offers the next worker", async () => {
    const { registration, show, watcher } = setup();
    await settle();
    watcher.dismiss();
    watcher.refresh();
    await settle();
    expect(show).toHaveBeenLastCalledWith(false);
    registration.waiting = new Worker();
    registration.dispatchEvent(new Event("updatefound"));
    await settle();
    expect(show).toHaveBeenLastCalledWith(true);
    watcher.dispose();
  });

  it("polls hourly only online and swallows update errors", async () => {
    const { registration, watcher } = setup();
    registration.update.mockRejectedValue(new Error("offline"));
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(registration.update).toHaveBeenCalledTimes(1);
    vi.stubGlobal("navigator", { onLine: false });
    await vi.advanceTimersByTimeAsync(60 * 60 * 1000);
    expect(registration.update).toHaveBeenCalledTimes(1);
    watcher.dispose();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("removes listeners, cancels a pending query and ignores late replies on disposal", async () => {
    const { registration, worker, container, show, query, watcher } = setup("current");
    await settle();
    let reply!: (id: string) => void;
    query.mockImplementationOnce(() => new Promise((resolve) => { reply = resolve; }));
    watcher.refresh();
    const signal = query.mock.calls.at(-1)![1] as AbortSignal;
    watcher.dispose();
    expect(signal.aborted).toBe(true);
    show.mockClear();
    reply("new");
    registration.dispatchEvent(new Event("updatefound"));
    worker.dispatchEvent(new Event("statechange"));
    container.dispatchEvent(new Event("controllerchange"));
    await settle();
    expect(show).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("worker build handshake", () => {
  function channel() {
    const port1 = { onmessage: null as ((event: { data: unknown }) => void) | null,
      onmessageerror: null as (() => void) | null, close: vi.fn() };
    const port2 = { close: vi.fn() };
    vi.stubGlobal("MessageChannel", class { port1 = port1; port2 = port2; });
    return { port1, port2 };
  }

  it("uses a private transferred port and closes it after the reply", async () => {
    const { port1, port2 } = channel();
    const worker = new Worker();
    const result = workerBuildId(worker as unknown as ServiceWorker, new AbortController().signal);
    expect(worker.postMessage).toHaveBeenCalledWith({ type: "AWFUL_BUILD_ID" }, [port2]);
    port1.onmessage!({ data: { type: "AWFUL_BUILD_ID", buildId: "release" } });
    expect(await result).toBe("release");
    expect(port1.close).toHaveBeenCalledOnce();
    expect(port2.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["timeout", "abort", "malformed", "error", "throw"])("cleans up on %s", async (mode) => {
    const { port1, port2 } = channel();
    const worker = new Worker();
    const controller = new AbortController();
    if (mode === "throw") worker.postMessage.mockImplementation(() => { throw new Error("gone"); });
    const result = workerBuildId(worker as unknown as ServiceWorker, controller.signal);
    if (mode === "timeout") await vi.advanceTimersByTimeAsync(2000);
    if (mode === "abort") controller.abort();
    if (mode === "malformed") port1.onmessage!({ data: { type: "wrong", buildId: "release" } });
    if (mode === "error") port1.onmessageerror!();
    expect(await result).toBeNull();
    expect(port1.close).toHaveBeenCalledOnce();
    expect(port2.close).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });
});
