/**
 * host.confirm()'s queue: plugin-raised yes/no dialogs in HOST-drawn
 * chrome. One dialog on screen at a time, one pending request per plugin -
 * a plugin asking again while its first waits gets an immediate false, so
 * nobody can stack popups over the app.
 */
export interface PluginConfirmRequest {
  id: string;
  pluginId: string;
  pluginName: string;
  pluginIcon: string;
  title: string;
  message: string;
  acceptLabel: string;
  declineLabel: string;
}

const MAX_QUEUE = 4;
const MAX_TEXT = 500;

const _resolvers = new Map<string, (accepted: boolean) => void>();

export const pluginConfirmState = $state({
  queue: [] as PluginConfirmRequest[],
});

export function requestPluginConfirm(
  plugin: { id: string; name: string; icon: string },
  options: {
    title: string;
    message: string;
    acceptLabel?: string;
    declineLabel?: string;
  }
): Promise<boolean> {
  if (
    pluginConfirmState.queue.some((r) => r.pluginId === plugin.id) ||
    pluginConfirmState.queue.length >= MAX_QUEUE
  ) {
    return Promise.resolve(false);
  }
  const request: PluginConfirmRequest = {
    id: crypto.randomUUID(),
    pluginId: plugin.id,
    pluginName: plugin.name,
    pluginIcon: plugin.icon,
    title: String(options.title ?? "").slice(0, 120),
    message: String(options.message ?? "").slice(0, MAX_TEXT),
    acceptLabel: String(options.acceptLabel ?? "Accept").slice(0, 40),
    declineLabel: String(options.declineLabel ?? "Decline").slice(0, 40),
  };
  return new Promise((resolve) => {
    _resolvers.set(request.id, resolve);
    pluginConfirmState.queue = [...pluginConfirmState.queue, request];
  });
}

export function resolvePluginConfirm(id: string, accepted: boolean): void {
  const resolver = _resolvers.get(id);
  _resolvers.delete(id);
  pluginConfirmState.queue = pluginConfirmState.queue.filter(
    (r) => r.id !== id
  );
  resolver?.(accepted);
}

/** Teardown (identity switch): every pending question is a decline. */
export function clearPluginConfirms(): void {
  for (const request of pluginConfirmState.queue)
    _resolvers.get(request.id)?.(false);
  _resolvers.clear();
  pluginConfirmState.queue = [];
}
