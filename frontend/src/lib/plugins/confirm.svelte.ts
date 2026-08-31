/**
 * host.confirm()'s queue: plugin-raised yes/no dialogs in HOST-drawn
 * chrome. One dialog on screen at a time, one pending request per plugin.
 *
 * Every ending is NAMED rather than collapsed into a boolean: "the user
 * said no", "nobody ever looked at it" and "the question was withdrawn"
 * are different facts, and a consent flow that cannot tell them apart
 * reports a silent peer as a refusal.
 */
export type PluginConfirmResult =
  | "accepted"
  /** Declined, or dismissed - dismissal is a refusal, fail closed. */
  | "declined"
  /** timeoutMs elapsed with no answer. */
  | "timeout"
  /** The caller aborted, or the session tore down. */
  | "withdrawn";

export interface PluginConfirmRequest {
  id: string;
  pluginId: string;
  pluginName: string;
  pluginIcon: string;
  /** Verified BY THE HOST: the peer this question is on behalf of. Never
   *  plugin-supplied text - that is what makes the line trustworthy. */
  fromPeerName?: string;
  title: string;
  message: string;
  acceptLabel: string;
  declineLabel: string;
  /** Wall-clock deadline for the countdown, when timeoutMs was given. */
  expiresAt?: number;
}

const MAX_QUEUE = 4;
const MAX_TEXT = 500;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 10 * 60_000;

interface Pending {
  resolve: (result: PluginConfirmResult) => void;
  timer?: ReturnType<typeof setTimeout>;
  detachAbort?: () => void;
}

const _pending = new Map<string, Pending>();

export const pluginConfirmState = $state({
  queue: [] as PluginConfirmRequest[],
});

/** Thrown rather than answered: a dropped request must never be readable
 *  as the user having refused. */
export class PluginConfirmBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PluginConfirmBusyError";
  }
}

export function requestPluginConfirm(
  plugin: { id: string; name: string; icon: string },
  options: {
    title: string;
    message: string;
    acceptLabel?: string;
    declineLabel?: string;
    timeoutMs?: number;
    signal?: AbortSignal;
    /** Host-verified display name for the peer being represented; the host
     *  resolves this from a DID before it reaches here. */
    fromPeerName?: string;
  }
): Promise<PluginConfirmResult> {
  if (pluginConfirmState.queue.some((r) => r.pluginId === plugin.id)) {
    return Promise.reject(
      new PluginConfirmBusyError(
        `${plugin.id} already has a dialog waiting for an answer`
      )
    );
  }
  if (pluginConfirmState.queue.length >= MAX_QUEUE) {
    return Promise.reject(
      new PluginConfirmBusyError("too many plugin dialogs are already queued")
    );
  }
  if (options.signal?.aborted) return Promise.resolve("withdrawn");

  const timeoutMs =
    typeof options.timeoutMs === "number" && Number.isFinite(options.timeoutMs)
      ? Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, options.timeoutMs))
      : null;

  const request: PluginConfirmRequest = {
    id: crypto.randomUUID(),
    pluginId: plugin.id,
    pluginName: plugin.name,
    pluginIcon: plugin.icon,
    ...(options.fromPeerName ? { fromPeerName: options.fromPeerName } : {}),
    title: String(options.title ?? "").slice(0, 120),
    message: String(options.message ?? "").slice(0, MAX_TEXT),
    acceptLabel: String(options.acceptLabel ?? "Accept").slice(0, 40),
    declineLabel: String(options.declineLabel ?? "Decline").slice(0, 40),
    ...(timeoutMs ? { expiresAt: Date.now() + timeoutMs } : {}),
  };

  return new Promise<PluginConfirmResult>((resolve) => {
    const entry: Pending = { resolve };
    if (timeoutMs) {
      entry.timer = setTimeout(
        () => settle(request.id, "timeout"),
        timeoutMs
      );
    }
    if (options.signal) {
      const onAbort = () => settle(request.id, "withdrawn");
      options.signal.addEventListener("abort", onAbort, { once: true });
      entry.detachAbort = () =>
        options.signal?.removeEventListener("abort", onAbort);
    }
    _pending.set(request.id, entry);
    pluginConfirmState.queue = [...pluginConfirmState.queue, request];
  });
}

function settle(id: string, result: PluginConfirmResult): void {
  const entry = _pending.get(id);
  if (!entry) return;
  _pending.delete(id);
  if (entry.timer) clearTimeout(entry.timer);
  entry.detachAbort?.();
  pluginConfirmState.queue = pluginConfirmState.queue.filter(
    (r) => r.id !== id
  );
  entry.resolve(result);
}

export function resolvePluginConfirm(id: string, accepted: boolean): void {
  settle(id, accepted ? "accepted" : "declined");
}

/** Teardown (identity switch): every pending question is withdrawn - it is
 *  not an answer, and must not read as one. */
export function clearPluginConfirms(): void {
  for (const request of [...pluginConfirmState.queue])
    settle(request.id, "withdrawn");
}
