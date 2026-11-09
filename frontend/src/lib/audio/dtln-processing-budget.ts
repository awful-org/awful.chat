/** Leave CPU headroom for capture, playback and the rest of the browser.
 * This is a conservative fallback policy, not a measurement of total CPU. */
export class DtlnProcessingBudget {
  private warmupMs = 0;
  private audioMs = 0;
  private busyMs = 0;
  private expensiveWindows = 0;

  sample(frames: number, sampleRate: number, elapsedMs: number): { load: number; overloaded: boolean } | null {
    const duration = frames * 1000 / sampleRate;
    // Ignore model/JIT startup; assess sustained real-time processing instead.
    if (this.warmupMs < 500) {
      this.warmupMs += duration;
      return null;
    }
    this.audioMs += duration;
    this.busyMs += elapsedMs;
    if (this.audioMs < 1000) return null;
    const load = this.busyMs / this.audioMs;
    this.expensiveWindows = load >= 0.65 ? this.expensiveWindows + 1 : 0;
    this.audioMs = 0;
    this.busyMs = 0;
    return { load, overloaded: this.expensiveWindows >= 2 };
  }
}
