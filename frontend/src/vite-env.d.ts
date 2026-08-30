/// <reference types="svelte" />
/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/svelte" />
/// <reference types="vite-plugin-pwa/info" />
/// <reference lib="webworker" />

/** Injected by vite define from package.json. */
declare const __APP_VERSION__: string;
declare const __APP_COMMIT__: string;

declare module "virtual:pwa-register" {
  export function registerSW(options?: {
    onNeedRefresh?: () => void;
    onOfflineReady?: () => void;
    onRegistered?: (
      registration: ServiceWorkerRegistration | undefined
    ) => void;
    onRegisteredSW?: (
      swUrl: string,
      registration: ServiceWorkerRegistration | undefined
    ) => void;
    register?: (val: boolean) => void;
    immediate?: boolean;
  }): () => void;
}

// gifenc ships no type declarations. Only the entry points the crop
// pipeline uses are declared here.
declare module "gifenc" {
  export type GifencFormat = "rgb565" | "rgb444" | "rgba4444";
  export function quantize(
    rgba: Uint8Array | Uint8ClampedArray,
    maxColors: number,
    options?: {
      format?: GifencFormat;
      oneBitAlpha?: boolean | number;
      clearAlpha?: boolean;
      clearAlphaThreshold?: number;
    }
  ): number[][];
  export function applyPalette(
    rgba: Uint8Array | Uint8ClampedArray,
    palette: number[][],
    format?: GifencFormat
  ): Uint8Array;
  export interface GIFEncoderInstance {
    writeFrame(
      index: Uint8Array,
      width: number,
      height: number,
      options?: {
        palette?: number[][];
        first?: boolean;
        transparent?: boolean;
        transparentIndex?: number;
        delay?: number;
        repeat?: number;
        dispose?: number;
      }
    ): void;
    finish(): void;
    bytes(): Uint8Array;
    bytesView(): Uint8Array;
    reset(): void;
  }
  export function GIFEncoder(options?: {
    auto?: boolean;
    initialCapacity?: number;
  }): GIFEncoderInstance;
}

// PWA install prompt event
interface BeforeInstallPromptEvent extends Event {
  readonly platforms: string[];
  readonly userChoice: Promise<{
    outcome: "accepted" | "dismissed";
    platform: string;
  }>;
  prompt(): Promise<void>;
}

// Screen Capture spec members TypeScript's DOM lib does not know yet
// (checked against lib.dom.d.ts shipped with TypeScript 5.9): windowAudio,
// restrictOwnAudio, and the picker-shaping options around them. Chromium
// ships all of these in stable; see frontend/src/lib/transport/share-audio.ts
// for why awful.chat depends on them to avoid a screen-share echo.
interface DisplayMediaStreamOptions {
  /** Audio scoping for a WINDOW surface. "window" asks for audio from
   * only the selected window; Chromium silently falls back to "system"
   * on platforms that cannot honour it (never observable from options
   * alone - see classifyShareAudio). */
  windowAudio?: "system" | "window" | "exclude";
  /** Whether system (whole-machine) audio is offered for MONITOR
   * surfaces. Does not apply to window or tab surfaces. */
  systemAudio?: "include" | "exclude";
  /** Whether the capturer's own tab/window may be offered in the picker. */
  selfBrowserSurface?: "include" | "exclude";
  /** Whether the browser offers a live surface-switch control mid-share. */
  surfaceSwitching?: "include" | "exclude";
  /** Whether whole-monitor surfaces appear in the picker at all. */
  monitorTypeSurfaces?: "include" | "exclude";
  /** Nudges the picker's audio checkbox on by default (Chrome 152+). */
  audioSelection?: "preferred";
}
interface MediaTrackConstraintSet {
  /** Strips the audio produced by the tab that called getDisplayMedia
   * out of whatever it captured. The fix for screen-share echo. */
  restrictOwnAudio?: ConstrainBoolean;
}
interface MediaTrackSupportedConstraints {
  /** Hardcoded `true` by the spec on every engine that knows the name -
   * including platforms, like Linux, that can never honour it. Proves
   * the name is recognised, never that it works. */
  restrictOwnAudio?: boolean;
}
interface MediaTrackSettings {
  /** The only reliable, post-capture proof that own-audio suppression
   * actually ran. */
  restrictOwnAudio?: boolean;
}

// Extend WindowEventMap to include beforeinstallprompt.
// This file is a global script, so an interface here is already global; a
// "declare global" wrapper silently does nothing and left InstallPrompt
// casting to any.
interface WindowEventMap {
  beforeinstallprompt: BeforeInstallPromptEvent;
}
interface Navigator {
  standalone?: boolean;
}
