const KIB = 1024;
const MIB = KIB * 1024;
const GIB = MIB * 1024;

/** Compact, readable significant figures without a long four-digit KB value. */
function scaled(value: number): string {
  if (value >= 100) return String(Math.round(value));
  if (value >= 10) return value.toFixed(1).replace(/\.0$/, "");
  return value.toFixed(2).replace(/\.?0+$/, "");
}

/** Bytes per second, choosing a unit before the number becomes unwieldy. */
export function formatTransferRate(bytesPerSecond: number): string {
  const rate = Number.isFinite(bytesPerSecond) ? Math.max(0, bytesPerSecond) : 0;
  if (rate < KIB) return `${Math.round(rate)} B/s`;
  // Switch at 1000 of the current unit, not 1024: 1019.6 KB/s is much easier
  // to read as 1 MB/s than as a four-digit number with a decimal fraction.
  if (rate < 1000 * KIB) return `${scaled(rate / KIB)} KB/s`;
  if (rate < 1000 * MIB) return `${scaled(rate / MIB)} MB/s`;
  return `${scaled(rate / GIB)} GB/s`;
}

/** A short ETA that keeps hours and minutes instead of reporting 152 minutes. */
export function formatTimeLeft(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(1, Math.ceil(seconds)) : 1;
  if (total < 60) return `~${total}s left`;
  const minutes = Math.ceil(total / 60);
  if (minutes < 60) return `~${minutes}m left`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) {
    const rest = minutes % 60;
    return `~${hours}h${rest ? ` ${rest}m` : ""} left`;
  }
  const days = Math.floor(hours / 24);
  const rest = hours % 24;
  return `~${days}d${rest ? ` ${rest}h` : ""} left`;
}
