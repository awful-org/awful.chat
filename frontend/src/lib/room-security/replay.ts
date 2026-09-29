/** Fixed-memory sequence window for one authenticated sender session.
 * Call only AFTER decrypting and verifying the sender signature. Bind sequence
 * and session ID in the authenticated payload. Never recycle a window for the
 * same session ID; eviction must retire the session, not permit replay.
 */
export class ReplayWindow {
  private highest = -1;
  private bitmap = 0n;

  accept(sequence: number): boolean {
    if (!Number.isSafeInteger(sequence) || sequence < 0) return false;
    if (sequence > this.highest) {
      const delta = sequence - this.highest;
      this.bitmap = delta >= 64 ? 1n : ((this.bitmap << BigInt(delta)) | 1n) & ((1n << 64n) - 1n);
      this.highest = sequence;
      return true;
    }
    const distance = this.highest - sequence;
    if (distance >= 64) return false;
    const bit = 1n << BigInt(distance);
    if ((this.bitmap & bit) !== 0n) return false;
    this.bitmap |= bit;
    return true;
  }
}
