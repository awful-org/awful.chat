/**
 * Which cameras exist, and which one to use.
 *
 * The app never enumerated video devices at all. startCamera asked for
 * `{ video: { width, height, frameRate } }` and took whatever the browser
 * called default, and no screen anywhere offered a choice - so a camera that
 * is not the default could not be selected, however plainly it was there.
 * That is why an iPhone offering itself as a Continuity Camera showed up in
 * Zoom and Meet and not here: they list video inputs and this did not.
 *
 * Two things follow, and the second is the one that matters for a phone:
 *
 * Labels are empty until camera permission has been granted at least once.
 * Before that the browser returns entries with blank labels, so a picker
 * shown to somebody who has never turned their camera on can only offer
 * "Camera 1". Turning it on once fixes it for good, which is why the list is
 * refreshed after every successful start.
 *
 * And the set CHANGES while the page is open. A Continuity Camera attaches
 * when the phone is unlocked and near the Mac, and detaches when it is not; a
 * USB webcam arrives mid-call. `devicechange` is the only notice of either,
 * so a list read once at mount is wrong within a minute.
 */

import { loadAudioPrefs, saveAudioPrefs } from "$lib/transport/audio-prefs";
import {
  onCameraStarted,
  startCamera,
  stopCamera,
} from "$lib/transport/call.svelte";
import { transportState } from "$lib/transport/transport.svelte";

interface CameraState {
  /** Video inputs, newest listing. Empty before the first refresh. */
  devices: MediaDeviceInfo[];
  /** The remembered choice, or null for the browser's default. */
  selected: string | null;
  /**
   * True when the browser is still withholding labels, i.e. camera
   * permission has never been granted. The picker says so rather than
   * showing a list of "Camera 1, Camera 2" as though that were the name.
   */
  unnamed: boolean;
}

export const cameras = $state<CameraState>({
  devices: [],
  selected: loadAudioPrefs().cameraDevice,
  unnamed: false,
});

/** Read the current video inputs. Safe to call often; it is a cheap query. */
export async function refreshCameras(): Promise<void> {
  if (typeof navigator === "undefined" || !navigator.mediaDevices) return;
  try {
    const all = await navigator.mediaDevices.enumerateDevices();
    const video = all.filter((d) => d.kind === "videoinput");
    cameras.devices = video;
    cameras.unnamed = video.length > 0 && video.every((d) => !d.label);
    // A remembered camera that is no longer here stops being the answer, or
    // the picker shows a selection that does not exist and getUserMedia
    // quietly returns something else.
    if (cameras.selected && !video.some((d) => d.deviceId === cameras.selected)) {
      cameras.selected = null;
      saveAudioPrefs({ cameraDevice: null });
    }
  } catch {
    // Blocked or unsupported: no list, and the default camera still works.
  }
}

let watching = false;

/**
 * Keep the list current for the life of the page. Idempotent, and never
 * removed - it is one listener, and both shells that show a picker would
 * otherwise register their own.
 */
export function watchCameras(): void {
  if (watching || typeof navigator === "undefined" || !navigator.mediaDevices) {
    return;
  }
  watching = true;
  navigator.mediaDevices.addEventListener("devicechange", () => {
    void refreshCameras();
  });
  // A first successful start is when the labels stop being blank.
  onCameraStarted(() => void refreshCameras());
  void refreshCameras();
}

/**
 * Use this camera from now on.
 *
 * Restarts a camera that is already running, because that is the whole point
 * of choosing one mid-call: stop and start republishes the track to the SFU,
 * which is what the other side needs to see the new picture.
 */
export async function setCamera(deviceId: string | null): Promise<void> {
  cameras.selected = deviceId;
  saveAudioPrefs({ cameraDevice: deviceId });
  if (transportState.cameraOff) return;
  stopCamera();
  await startCamera();
  // Permission has certainly been granted by now, so the labels the first
  // listing lacked are available.
  await refreshCameras();
}

/** The label to show for a device, never an empty string. */
export function cameraLabel(device: MediaDeviceInfo, index: number): string {
  return device.label || `Camera ${index + 1}`;
}
