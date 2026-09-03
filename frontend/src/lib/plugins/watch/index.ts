/**
 * Public entry point for the watch-party sync library. Plugin authors
 * import from here, never from `./sync` directly.
 */
export {
  estimateClock,
  projectPosition,
  decideCorrection,
  DEFAULT_WATCH_SYNC,
  watchKeyIntent,
} from "./sync";
export type {
  WatchTick,
  ClockSample,
  ClockEstimate,
  CorrectionAction,
  Correction,
  WatchSyncConfig,
  WatchKeyIntent,
} from "./sync";
