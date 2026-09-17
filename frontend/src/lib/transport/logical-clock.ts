/** Per-conversation counters shared by room, DM and teardown send paths. */
const clocks = new Map<string, number>();

// Clock-independent bootstrap allowance includes legacy millisecond counters
// (even badly future-dated ones), but leaves ~8.7 quadrillion increments before
// numeric exhaustion. Above it, a peer can advance only by a bounded step.
const BOOTSTRAP_CEILING = 2 ** 48;
const MAX_REMOTE_JUMP = 1_000_000;

export function remoteLamportAllowed(room: string, value: unknown): value is number {
  return validLamport(value) && value <= Math.max(
    BOOTSTRAP_CEILING, (clocks.get(room) ?? 0) + MAX_REMOTE_JUMP
  );
}

export function validLamport(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) &&
    value >= 0 && value < Number.MAX_SAFE_INTEGER;
}

export function observeLamport(room: string, value: number): void {
  if (validLamport(value)) clocks.set(room, Math.max(clocks.get(room) ?? 0, value));
}

export function issueLamport(room: string): number {
  const next = (clocks.get(room) ?? 0) + 1;
  if (!validLamport(next)) throw new Error("Conversation sequence is exhausted; cannot send safely.");
  clocks.set(room, next);
  return next;
}
