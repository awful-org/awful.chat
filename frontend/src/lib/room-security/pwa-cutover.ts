/** A one-time activation boundary for the incompatible room protocol release.
 * Keep this marker outside Workbox's per-build precache: ordinary later updates
 * retain the normal user-controlled reload behavior. */
const CACHE = "awful-room-security-cutover-v2";
const PENDING = "/__room-security-cutover/pending";
const COMPLETE = "/__room-security-cutover/complete";

/** Start navigations without extending the activation lifetime through them.
 * Controlled navigations can themselves wait for activation to complete. */
export function navigateSecurityCutoverWindows(
  windows: Iterable<{ url: string; navigate(url: string): Promise<unknown> }>,
): void {
  for (const window of windows) void window.navigate(window.url).catch(() => null);
}

export async function installSecurityCutover(
  storage: CacheStorage,
  hasActiveWorker: boolean,
  skipWaiting: () => Promise<void>,
): Promise<void> {
  if (!hasActiveWorker) return;
  const cache = await storage.open(CACHE);
  if (await cache.match(COMPLETE)) return;
  await cache.put(PENDING, new Response("2"));
  await skipWaiting();
}

export async function activateSecurityCutover(
  storage: CacheStorage,
  reloadControlledWindows: () => Promise<void>,
): Promise<void> {
  const cache = await storage.open(CACHE);
  if (await cache.match(COMPLETE)) return;
  const pending = await cache.match(PENDING);
  // Persist before navigation so subsequent worker restarts cannot reload-loop.
  await cache.put(COMPLETE, new Response("2"));
  await cache.delete(PENDING);
  if (pending) await reloadControlledWindows();
}
