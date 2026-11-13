/** Ask the actual waiting worker, not the network's potentially newer deploy. */
export function workerBuildId(
  worker: ServiceWorker,
  signal: AbortSignal,
): Promise<string | null> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const finish = (id: string | null) => {
      clearTimeout(timeout);
      signal.removeEventListener("abort", abort);
      channel.port1.onmessage = null;
      channel.port1.onmessageerror = null;
      channel.port1.close();
      channel.port2.close();
      resolve(id);
    };
    const abort = () => finish(null);
    const timeout = setTimeout(() => finish(null), 2000);
    signal.addEventListener("abort", abort, { once: true });
    channel.port1.onmessage = ({ data }) => finish(
      data?.type === "AWFUL_BUILD_ID" && typeof data.buildId === "string" && data.buildId
        ? data.buildId : null,
    );
    channel.port1.onmessageerror = abort;
    if (signal.aborted) return abort();
    try {
      worker.postMessage({ type: "AWFUL_BUILD_ID" }, [channel.port2]);
    } catch {
      finish(null);
    }
  });
}

/**
 * A waiting SW can coexist with a page already loaded from that release (for
 * example, a network navigation while another tab keeps the old SW alive).
 * Compare to this page's compiled identity, NOT the old controlling worker.
 * Unknown/legacy workers deliberately retain the old prompt behavior: hiding
 * them would strand genuine upgrades. No automatic activation is performed.
 */
export function watchPwaUpdate(
  registration: ServiceWorkerRegistration,
  runningBuildId: string,
  show: (available: boolean) => void,
  container: ServiceWorkerContainer,
  query = workerBuildId,
) {
  let disposed = false;
  let generation = 0;
  let pending: AbortController | undefined;
  let offered: ServiceWorker | null = null;
  let dismissed: ServiceWorker | null = null;
  const workers = new Set<ServiceWorker>();

  const observe = (worker: ServiceWorker | null) => {
    if (!worker || workers.has(worker)) return;
    workers.add(worker);
    worker.addEventListener("statechange", refresh);
  };

  function refresh() {
    if (disposed) return;
    const request = ++generation;
    pending?.abort();
    pending = undefined;
    observe(registration.installing);
    observe(registration.waiting);
    const waiting = registration.waiting;
    offered = null;
    show(false);
    if (!waiting || waiting.state !== "installed" || waiting === dismissed) return;
    const controller = new AbortController();
    pending = controller;
    void query(waiting, controller.signal).catch(() => null).then((id) => {
      if (disposed || request !== generation || registration.waiting !== waiting ||
          waiting.state !== "installed") return;
      if (!runningBuildId || !id || runningBuildId !== id) {
        offered = waiting;
        show(true);
      }
    });
  }

  registration.addEventListener("updatefound", refresh);
  container.addEventListener("controllerchange", refresh);
  const poll = setInterval(() => {
    if (navigator.onLine) void registration.update().catch(() => {});
  }, 60 * 60 * 1000);
  refresh();

  return {
    refresh,
    dismiss() {
      dismissed = registration.waiting;
      ++generation;
      pending?.abort();
      offered = null;
      show(false);
    },
    isCurrent() {
      return !!offered && registration.waiting === offered && offered.state === "installed";
    },
    dispose() {
      disposed = true;
      ++generation;
      pending?.abort();
      clearInterval(poll);
      registration.removeEventListener("updatefound", refresh);
      container.removeEventListener("controllerchange", refresh);
      for (const worker of workers) worker.removeEventListener("statechange", refresh);
      workers.clear();
    },
  };
}
