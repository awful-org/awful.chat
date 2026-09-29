import { Html5Qrcode } from "html5-qrcode";

/**
 * The camera QR scanner: device sync and joining a room both use it.
 *
 * One scanner at a time - there is one camera to hold. What a code MEANS is
 * the caller's business: onText gets every decoded string and says whether it
 * was the one it wanted, which stops the scan.
 */

/** A camera the QR scanner can run on. */
export interface ScanCamera {
  id: string;
  label: string;
}

/**
 * Camera state for the QR scanner.
 *
 * Its own store: this is about the hardware in front of the user, it means
 * nothing outside the scan view, and it changes several times while a camera
 * is starting.
 */
export const scannerState = $state({
  /**
   * The camera has been asked for and the user has not answered yet.
   *
   * Distinct from scanning and distinct from an error. On a phone the prompt
   * sits there for as long as it takes somebody to read it, and for that whole
   * time the view was a black square saying nothing at all - which reads as a
   * broken scanner, not as a question waiting for an answer.
   */
  awaitingPermission: false,
  /** Every camera on the device, once permission has been granted. */
  cameras: [] as ScanCamera[],
  activeCameraId: null as string | null,
  /** The running camera has a torch, and it can be switched. */
  torchAvailable: false,
  torchOn: false,
});

let _scanner: Html5Qrcode | null = null;
/** The element the running camera draws into: its viewfinder's own id. */
let _scannerElement: string | null = null;

const BACK_CAMERA = /\b(back|rear|environment)\b/i;
const FRONT_CAMERA = /\b(front|user|facetime)\b/i;
/**
 * iPhones list every lens as its own camera. The ultra wide cannot focus on
 * a phone held a hand's width away and the telephoto focuses no closer than
 * arm's length, so either one "opens" and then never reads a thing.
 */
const CLOSE_FOCUS_UNFRIENDLY = /ultra|tele|zoom/i;

/**
 * The camera to open first.
 *
 * `{ facingMode: "environment" }` was a constraint, not a choice, and a
 * browser that cannot honour it gets to pick - which on several Androids is
 * the front camera, pointed at the face of somebody holding their other phone
 * up to the back of the device. Naming a device id makes the choice explicit,
 * and it gives the UI something to offer a switch between.
 */
export function preferBackCamera(cameras: ScanCamera[]): string | null {
  if (cameras.length === 0) return null;
  const backs = cameras.filter((c) => BACK_CAMERA.test(c.label));
  const back =
    backs.find((c) => !CLOSE_FOCUS_UNFRIENDLY.test(c.label)) ?? backs[0];
  // Nothing labelled: the last entry is the back camera on most Androids, and
  // on a single-camera device it is the only one there is.
  return (back ?? cameras[cameras.length - 1]).id;
}

/** Which way the camera faces, when its label says. */
export function cameraFacing(camera: ScanCamera | undefined): "front" | "back" | null {
  if (!camera) return null;
  if (FRONT_CAMERA.test(camera.label)) return "front";
  if (BACK_CAMERA.test(camera.label)) return "back";
  return null;
}

/**
 * The camera on the other side: back to front and front to back.
 *
 * Front and back, not "the next camera": stepping through the list put an
 * iPhone on its ultra wide and telephoto lenses on the way round, neither of
 * which can read a code held up close. Without labels to tell the sides
 * apart it falls back to the next camera in the list.
 */
export function otherSideCameraId(
  cameras: ScanCamera[] = scannerState.cameras,
  activeId: string | null = scannerState.activeCameraId
): string | null {
  if (cameras.length < 2) return null;
  const active = cameras.find((c) => c.id === activeId);
  const front = cameras.find((c) => cameraFacing(c) === "front");
  if (cameraFacing(active) === "front") {
    const back = preferBackCamera(cameras.filter((c) => c.id !== activeId));
    return back;
  }
  if (front) return front.id;
  const at = cameras.findIndex((c) => c.id === activeId);
  return cameras[(at + 1) % cameras.length].id;
}

/** Read the running camera's torch support; never throws. */
function readTorchSupport(): void {
  if (!_scanner) return;
  try {
    // The same MediaTrackCapabilities.torch the platform reports, read
    // through the wrapper that also knows how to apply it.
    const torch = _scanner.getRunningTrackCameraCapabilities().torchFeature();
    scannerState.torchAvailable = torch.isSupported();
    scannerState.torchOn = torch.value() === true;
  } catch {
    // No running camera, or a browser that reports no capabilities.
    scannerState.torchAvailable = false;
    scannerState.torchOn = false;
  }
}

/**
 * Start the camera in the element with this id. Resolves once it runs, or
 * rejects when there is no camera to run (refused, missing, busy).
 */
export async function startQrScan(
  elementId: string,
  /** Every decoded string; true when it was the code wanted, which stops the scan. */
  onText: (text: string) => boolean,
  /** A camera picked by the user (the front/back switch); else the back one. */
  cameraId?: string
): Promise<void> {
  await stopQrScan();
  scannerState.torchAvailable = false;
  scannerState.torchOn = false;
  // getCameras() is what raises the permission prompt, and it does not
  // resolve until the user has answered it - so this, and only this, is the
  // window in which the view should say it is waiting for them.
  if (scannerState.cameras.length === 0) {
    scannerState.awaitingPermission = true;
    try {
      scannerState.cameras = (await Html5Qrcode.getCameras()).map((c) => ({
        id: c.id,
        label: c.label,
      }));
    } finally {
      scannerState.awaitingPermission = false;
    }
  }
  const target = cameraId ?? preferBackCamera(scannerState.cameras);
  scannerState.activeCameraId = target;

  const scanner = new Html5Qrcode(elementId);
  _scanner = scanner;
  _scannerElement = elementId;
  try {
    await startCamera(scanner, target, onText);
  } catch (err) {
    if (_scanner === scanner) {
      _scanner = null;
      _scannerElement = null;
    }
    throw err;
  }
  readTorchSupport();
}

function startCamera(
  scanner: Html5Qrcode,
  target: string | null,
  onText: (text: string) => boolean
): Promise<null> {
  return scanner.start(
    // Ignored once videoConstraints is set, but the API wants it.
    target ?? { facingMode: "environment" },
    {
      fps: 10,
      qrbox: { width: 250, height: 250 },
      // Without a size the browser picks, and iOS Safari picks small: a
      // 41-module code a third of the way across a 480-line frame is
      // three pixels a square, under what the decoder can read. `ideal`
      // is a preference, so a camera that cannot do 720p still opens.
      videoConstraints: {
        // A device id when the enumeration gave one; the old facingMode
        // constraint stays as the fallback for a browser that listed nothing.
        ...(target ? { deviceId: { exact: target } } : { facingMode: "environment" }),
        width: { ideal: 1280 },
        height: { ideal: 720 },
      },
    },
    (decodedText) => {
      if (_scanner === scanner && onText(decodedText)) void stopQrScan();
    },
    () => {
      // Scan error - usually just means no QR code in frame, ignore
    }
  );
}

/** Switch the running camera's torch. Silently does nothing without one. */
export async function toggleScanTorch(): Promise<void> {
  if (!_scanner || !scannerState.torchAvailable) return;
  const next = !scannerState.torchOn;
  try {
    await _scanner.getRunningTrackCameraCapabilities().torchFeature().apply(next);
    scannerState.torchOn = next;
  } catch {
    // Some devices advertise a torch and then refuse to switch it while the
    // camera is running. Drop the control rather than leave a button that
    // does nothing.
    scannerState.torchAvailable = false;
  }
}

/**
 * Stop the camera, if one is running. With an element id, only when the
 * camera is that viewfinder's: a closing view must not stop the one that
 * replaced it.
 */
export async function stopQrScan(elementId?: string): Promise<void> {
  if (elementId !== undefined && elementId !== _scannerElement) return;
  const scanner = _scanner;
  const torchOn = scannerState.torchOn;
  _scanner = null;
  _scannerElement = null;
  scannerState.awaitingPermission = false;
  scannerState.torchAvailable = false;
  scannerState.torchOn = false;
  if (scanner) {
    // Off before the stop: some Androids leave the torch burning after the
    // camera is released, and nothing in the app can reach it again.
    if (torchOn) {
      try {
        await scanner.getRunningTrackCameraCapabilities().torchFeature().apply(false);
      } catch {
        // Nothing more to try; the stop below releases the device anyway.
      }
    }
    try {
      await scanner.stop();
    } catch {
      // Ignore stop errors
    }
  }
  // cameras and activeCameraId deliberately survive: a camera switch stops
  // and restarts, and re-enumerating would re-prompt on some browsers.
}
