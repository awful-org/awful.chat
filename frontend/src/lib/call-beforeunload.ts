// Shared by the app and quick-call shells. Even if their lifetimes overlap,
// there must be only one confirmation listener.
const owners = new Set<symbol>();

function confirmLeave(event: BeforeUnloadEvent): void {
  event.preventDefault();
  // Legacy browsers require returnValue; the browser supplies the wording.
  event.returnValue = "";
}

/**
 * Call from a shell's effect with transportState.inCall and return the cleanup.
 * No listener while idle, joining, or ringing; no teardown until pagehide, so
 * cancelling the browser's confirmation leaves the call running.
 */
export function warnBeforeLeavingCall(inCall: boolean): () => void {
  if (!inCall || typeof window === "undefined") return () => {};
  const target = window;
  const owner = Symbol();
  if (owners.size === 0) target.addEventListener("beforeunload", confirmLeave);
  owners.add(owner);
  return () => {
    if (!owners.delete(owner)) return;
    if (owners.size === 0) target.removeEventListener("beforeunload", confirmLeave);
  };
}
