# Choppy audio when DTLN is enabled

Investigated 2026-11-08 against upstream `3eebb59`. Reported environment:
Arch Linux, Zen browser; during calls, enabling suppression distorts both
outgoing speech and the other participants' playback.

## Finding

The generated `frontend/public/audio-worklet.js` calls the WASM model
synchronously inside `AudioWorkletProcessor.process()`. A 128-frame render
quantum at 48 kHz has a 2.67 ms deadline. Although inference runs only when a
model block is ready, the callback containing that inference still has the
same deadline. Average CPU usage being acceptable does not prevent dropouts.

The incoming voice path in `LibP2PVoice.setupRemoteAudio()` does not pass
through DTLN. A local render-thread stall, rather than the model filtering
other people's voices, fits both directions becoming choppy. Firefox's audio
rendering work can share a processing thread across contexts ([destination graph selection](https://github.com/mozilla-firefox/firefox/blob/main/dom/media/webaudio/AudioDestinationNode.cpp)); moving inference
off that thread removes this source of contention. This reproduces the timing
failure on Firefox, but the user's exact Zen/device combination has not been
measured directly.

References: [Chrome's AudioWorklet design patterns](https://developer.chrome.com/blog/audio-worklet-design-pattern)
and [Mozilla's realtime audio guidance](https://hacks.mozilla.org/2020/05/high-performance-web-audio-with-audioworklet-in-firefox/).

## Measurements

Using the actual shipped model, synthetic input, and 2,000 real-time callbacks
per browser at 48 kHz:

| Pipeline | Chromium over-budget callbacks | Firefox over-budget callbacks | Worst callback |
| --- | ---: | ---: | --- |
| Original synchronous model | 165 | 165 | 25 ms Chromium / 27 ms Firefox |
| Buffered dedicated worker | 0 | 0 | 1 ms in both browsers |

The browser callback timer uses millisecond-resolution `Date.now()`, so these
are coarse timing measurements, not sub-millisecond precision claims. An
independent Node VM benchmark of the original model measured a 17.5 ms p95
callback and a 26.6 ms maximum, against the same 2.67 ms budget.

The new path also completed 2,000 callbacks at each of 44.1, 48 and 96 kHz in
both browsers, with no measured over-budget callbacks. Minified worker and
worklet bundles loaded under production-style script/worker/WASM CSP in both
engines. All browser input was synthetic; no microphone permission or room
connection was used.

A stop/resume cycle also completed 4,000 callbacks in each browser without a
worker failure (worst callback 2 ms Chromium / 3 ms Firefox).

A separate real-model check compared the worker's in-place quantum processing
with out-of-place processing: 51,200 output samples matched exactly.

## Change

- `dtln-bridge-worklet.ts`: lightweight 512-sample batches, a sample-rate-aware
  output cushion of at least 32 ms, and bounded queues. It transfers buffers
  instead of doing inference on the realtime rendering thread.
- `dtln-worker.ts`: loads the existing generated bundle unchanged, adapts its
  processor registration, and runs the original 128-frame processing steps,
  preserving its model, gate and resampling behavior.
- `DtlnProcessor`: owns worker/port lifecycle and propagates initialization,
  runtime and backlog failures. Stopping an idle graph clears the bridge's
  buffered samples and ignores late replies from its previous generation.
- `LibP2PVoice.handleDtlnFatal()`: uses native browser suppression after runtime
  failure rather than repeatedly restarting a worker that cannot keep up.
  DTLN can be explicitly enabled again; the saved preference is retained.

Buffering adds about 32–35 ms at the tested sample rates, plus batching and the
model's existing delay. The generated model bundle and content-hashed URL are
unchanged. Deployment is still required before this affects awful.chat users.

Validation completed: `pnpm check`, 79 selected audio/voice tests, and
`pnpm build` pass.
