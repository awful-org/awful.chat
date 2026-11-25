/**
 * Keeping the screen on, for as long as anything needs it.
 *
 * Counted: a call and a device sync can both be under way, and the end of one
 * must not let the screen go dark on the other. The browser drops the lock
 * whenever the page is hidden, so it is taken again when the page comes back.
 */

const holders = new Set<symbol>();
let lock: WakeLockSentinel | null = null;
let asking = false;

/** Keep the screen on until the returned function is called. Safe to call twice. */
export function keepScreenAwake(): () => void {
  const holder = Symbol();
  holders.add(holder);
  void take();
  return () => {
    if (!holders.delete(holder) || holders.size > 0) return;
    void lock?.release().catch(() => {});
    lock = null;
  };
}

async function take(): Promise<void> {
  if (lock || asking || holders.size === 0) return;
  if (typeof navigator === "undefined" || !("wakeLock" in navigator)) return;
  asking = true;
  try {
    const got = await navigator.wakeLock.request("screen");
    // Nobody left wanting it by the time it was granted.
    if (holders.size === 0) {
      void got.release().catch(() => {});
      return;
    }
    lock = got;
    got.addEventListener("release", () => {
      if (lock === got) lock = null;
    });
  } catch {
    // Denied, unsupported or hidden: everything works without it.
  } finally {
    asking = false;
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void take();
  });
}
