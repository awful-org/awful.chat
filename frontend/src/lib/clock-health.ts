/** A clock-health sample compares wall time with monotonic elapsed time. */
export interface ClockSample { wall: number; monotonic: number }
export function clockJumped(before: ClockSample, after: ClockSample): boolean {
  return Math.abs((after.wall - before.wall) - (after.monotonic - before.monotonic)) > 60_000;
}

export function reservationClockWarning(error: unknown): string | null {
  const pending = [error];
  const seen = new Set<unknown>();
  while (pending.length && seen.size < 32) {
    const current = pending.shift();
    if (seen.has(current)) continue;
    seen.add(current);
    const message = current instanceof Error ? current.message : String(current);
    if (/Tag ttl must be .*greater than 0/i.test(message)) {
      return "Relay reservation appears expired. Check automatic date and time on this device; the relay operator should also check its clock. Reload after correcting the time.";
    }
    if (current instanceof Error && current.cause) pending.push(current.cause);
    if (current instanceof AggregateError) pending.push(...current.errors.slice(0, 32));
  }
  return null;
}
