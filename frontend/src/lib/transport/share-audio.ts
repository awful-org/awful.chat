/**
 * Scoped screen-share audio: the getDisplayMedia() request to send, and the
 * decision about whether the audio track that comes back is safe to publish.
 *
 * The problem this fixes: a screen share that captures whole-system audio
 * also captures awful.chat's own playback of every remote participant. The
 * SFU forwards that back out, so everyone hears themselves a moment later.
 *
 * The fix has two halves, kept apart on purpose:
 *   - buildShareOptions() asks the platform to avoid the echo up front
 *     (windowAudio: "window", restrictOwnAudio).
 *   - classifyShareAudio() checks whether it actually worked, because both
 *     of those options can degrade or fail SILENTLY. Chromium falls back
 *     from per-application audio to whole-system audio without telling the
 *     page (Chromium CL 7487294, "gDM: Fallback to system audio when
 *     window audio is unsupported"), and getSupportedConstraints() reports
 *     restrictOwnAudio as usable on platforms, like Linux, that can never
 *     honour it. The only trustworthy signal is what the browser reports
 *     back on the live tracks after capture has already started.
 *
 * This module has no DOM side effects and touches no transport state, so it
 * is unit-testable against the W3C Screen Capture spec's platform matrix
 * (Windows 11, Windows 10, macOS 14.2+, Linux) without a browser - see
 * share-audio.test.ts.
 */

/**
 * The outcome of checking a captured screen-share audio track against the
 * settings the browser actually gave us.
 *
 * "application-scoped" and "system-audio-own-audio-stripped" are both SAFE
 * to publish - neither can contain this call's own voice. They are named
 * separately because they mean different things to a sharer even though
 * awful.chat cannot always tell them apart from JavaScript (see the
 * "window surface" branch in classifyShareAudio below): the browser gives
 * no signal that distinguishes "genuinely captured only that application"
 * from "captured the whole system, then filtered our own output back out".
 */
export type ShareAudioVerdictKind =
  | "application-scoped"
  | "system-audio-own-audio-stripped"
  | "echo-risk"
  | "no-audio";

export interface ShareAudioVerdict {
  kind: ShareAudioVerdictKind;
  /** Machine-readable explanation, for logs and tests - not shown to the user. */
  reason: string;
  /** One sentence for the sharer, matching this verdict. */
  message: string;
}

/**
 * The single getDisplayMedia() options object for a screen share.
 *
 * Ship ONE object; never branch on the browser's user agent. Every member
 * here is a WebIDL dictionary member - an engine that does not recognise
 * one silently drops it (W3C Screen Capture spec is explicit: unknown
 * members are ignored, not rejected). Firefox and Safari know none of the
 * audio-scoping vocabulary below and fall back to whatever they already do;
 * this function does not need to know that.
 *
 * The one real conditional is restrictOwnAudio. Its presence in
 * `supported` only proves the ENGINE recognises the name (the spec
 * hardcodes it to `true` in the IDL, even on platforms - Linux - that can
 * never honour it) but it is still the only pre-picker signal available,
 * and it changes which audio-processing settings are correct: real own-
 * audio restriction beats browser echo-cancellation, so ask for verbatim
 * stereo when restriction might apply, and fall back to lossy mono AEC
 * (Chrome's own workaround before restrictOwnAudio existed) when it can't.
 */
export function buildShareOptions(
  supported: MediaTrackSupportedConstraints
): DisplayMediaStreamOptions {
  const audio: MediaTrackConstraints = supported.restrictOwnAudio
    ? {
        // Removes this document's own output from whatever got captured.
        // Chrome 141+, Windows and macOS only - but harmless to request
        // everywhere else, since an engine that does not honour it just
        // ignores it.
        restrictOwnAudio: true,
        // Verbatim capture: no mic-style processing on game/media audio.
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        channelCount: 2,
        sampleRate: 48000,
      }
    : {
        // restrictOwnAudio cannot help here. Chrome turned echoCancellation
        // OFF by default for getDisplayMedia audio in M137 (crbug
        // 422611724), so without restriction to lean on, ask for it
        // explicitly - exactly what Jitsi does for the same platforms.
        // Mono because AEC processing already costs fidelity; asking for
        // stereo on top of it buys nothing.
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        channelCount: 1,
      };

  return {
    video: {
      // A picker-ordering HINT only - the spec guarantees displaySurface
      // can never cause OverconstrainedError - so this can only nudge the
      // user toward a window, never break the capture.
      displaySurface: "window",
      frameRate: { ideal: 30 },
    },
    audio,
    // Ask for real per-application audio where the platform can give it
    // (Windows 11 + Chrome 146+, macOS 14.2+ + Chrome 150+). Falls back to
    // system audio, then to nothing, everywhere else - restrictOwnAudio
    // above, and classifyShareAudio after capture, are what keep that safe.
    windowAudio: "window",
    // Still let a whole-screen share carry audio; restrictOwnAudio is what
    // keeps that echo-free, not this.
    systemAudio: "include",
    monitorTypeSurfaces: "include",
    // Never offer awful.chat's own window/tab in the picker - there is
    // nothing useful to share from inside the call, and Chromium refuses
    // application-audio capture of its own windows anyway.
    selfBrowserSurface: "exclude",
    surfaceSwitching: "include",
    // Chrome 152+: nudges the picker's audio checkbox on by default.
    audioSelection: "preferred",
  };
}

/**
 * Decide whether a captured screen-share audio track is safe to publish.
 *
 * Echo risk exists only for a non-tab surface whose own audio was not
 * confirmed stripped: a tab capture cannot contain awful.chat's own voice
 * (selfBrowserSurface excludes our own tab from the picker), so it is safe
 * by construction regardless of restrictOwnAudio. Everything else needs
 * restrictOwnAudio to have actually applied - not merely been requested.
 *
 * Fails closed: any surface value this function does not recognise is
 * treated as risky, never as safe by default.
 */
export function classifyShareAudio(
  videoSettings: MediaTrackSettings,
  audioSettings: MediaTrackSettings | null
): ShareAudioVerdict {
  if (!audioSettings) {
    return {
      kind: "no-audio",
      reason: "getDisplayMedia returned a stream with no audio track",
      message:
        "This share has no audio - the browser can return video only even when audio was requested. Re-share and check the audio box in the picker if you want sound.",
    };
  }

  const surface = videoSettings.displaySurface;
  // getSettings().restrictOwnAudio is the ONLY reliable proof that own-audio
  // suppression actually ran. getSupportedConstraints() cannot be trusted
  // for this (it lies on Linux), and the request can silently degrade
  // without telling the page. Trust only the live track's own settings.
  const restricted = audioSettings.restrictOwnAudio === true;

  if (surface === "browser") {
    // A captured tab is, by construction, some OTHER page's audio - our own
    // tab is excluded from the picker, so there is no echo path here.
    return {
      kind: "application-scoped",
      reason: "tab surface audio is scoped to that tab, not the whole system",
      message: "Sharing this tab's audio only.",
    };
  }

  if (restricted && surface === "window") {
    // Cannot tell, from JavaScript, whether this is genuine per-application
    // loopback (Windows 11 Chrome 146+, macOS 14.2+ Chrome 150+) or a
    // system-audio fallback that restrictOwnAudio filtered clean - Chromium
    // exposes no signal that distinguishes them. Both are echo-free, so a
    // window pick gets the benefit of the doubt.
    return {
      kind: "application-scoped",
      reason:
        "window surface with confirmed own-audio removal (genuine per-app loopback, or a system-audio fallback filtered clean - indistinguishable from here)",
      message: "Sharing this window's audio.",
    };
  }

  if (restricted && surface === "monitor") {
    // A monitor pick is definitely whole-system audio, even though it is
    // safe: restrictOwnAudio strips our own output from it either way.
    return {
      kind: "system-audio-own-audio-stripped",
      reason:
        "monitor surface with confirmed own-audio removal: whole-system audio, minus this call's own output",
      message: "Sharing your whole screen's audio (this call's own sound is removed).",
    };
  }

  // Either restriction was requested but never confirmed, or the surface is
  // something this function does not recognise. Either way, do not assume
  // safety we cannot prove.
  return {
    kind: "echo-risk",
    reason: restricted
      ? `own-audio removal confirmed but surface "${String(surface)}" is not a recognised safe surface`
      : "non-tab surface with unconfirmed own-audio suppression: the captured audio can contain this call's own voice played back to everyone",
    message:
      "This share's audio was not confirmed echo-safe, so it was not sent - everyone would otherwise hear themselves a moment later. Share a single window with its audio box checked, or turn on \"Send audio despite echo risk\" in Settings > Audio to send it anyway.",
  };
}
