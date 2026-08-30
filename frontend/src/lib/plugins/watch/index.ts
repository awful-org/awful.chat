/**
 * Public entry point for the watch-party sync library. Plugin authors
 * import from here, never from `./sync` directly.
 */
export {
  estimateClock,
  projectPosition,
  decideCorrection,
  DEFAULT_WATCH_SYNC,
} from "./sync";
export type {
  WatchTick,
  ClockSample,
  ClockEstimate,
  CorrectionAction,
  Correction,
  WatchSyncConfig,
} from "./sync";
