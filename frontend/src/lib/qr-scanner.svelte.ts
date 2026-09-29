import jsQR from "jsqr";

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

/**
 * The platform's QR detector, where there is one (Chrome on Android, macOS,
 * ChromeOS). Not in TypeScript's DOM types yet.
 */
interface QrDetector {
  detect(source: CanvasImageSource): Promise<{ rawValue: string }[]>;
}
interface QrDetectorClass {
  new (options: { formats: string[] }): QrDetector;
  getSupportedFormats(): Promise<string[]>;
}

async function nativeDetector(): Promise<QrDetector | null> {
  const Detector = (globalThis as { BarcodeDetector?: QrDetectorClass }).BarcodeDetector;
  if (!Detector) return null;
  try {
    if (!(await Detector.getSupportedFormats()).includes("qr_code")) return null;
    return new Detector({ formats: ["qr_code"] });
  } catch {
    return null;
  }
}

/** The running scan: one at a time, there is one camera to hold. */
interface Session {
  element: string;
  stream: MediaStream;
  video: HTMLVideoElement;
  timer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}
let _session: Session | null = null;

/** How often a frame is read. A decode is 10-40ms; more often only heats the phone. */
const SCAN_INTERVAL_MS = 150;
/**
 * The frame is decoded at the camera's own resolution, only capped. The old
 * scanner (html5-qrcode) shrank it to the scan box's size ON SCREEN first: a
 * 1080p camera in a phone-width viewfinder came down to ~300px, and a code
 * held at a normal distance to under two pixels a square - unreadable, which
 * is why scanning "did nothing" on real cameras.
 */
const MAX_DECODE_SIDE = 960;

function videoConstraints(cameraId: string | null): MediaTrackConstraints {
  return {
    // A device id when the enumeration gave one; facingMode for the first
    // open, before there is a list to choose from.
    ...(cameraId ? { deviceId: { exact: cameraId } } : { facingMode: { ideal: "environment" } }),
    // Without a size the browser picks, and iOS Safari picks small. `ideal`,
    // so a camera that cannot do it still opens.
    width: { ideal: 1280 },
    height: { ideal: 720 },
  };
}

async function listCameras(): Promise<ScanCamera[]> {
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "videoinput")
    .map((d, i) => ({ id: d.deviceId, label: d.label || `Camera ${i + 1}` }));
}

/**
 * Start the camera inside the element with this id. Resolves once it runs,
 * or rejects when there is no camera to run (refused, missing, busy).
 */
export async function startQrScan(
  elementId: string,
  /** Every decoded string; true when it was the code wanted, which stops the scan. */
  onText: (text: string) => boolean,
  /** A camera picked by the user (the front/back switch); else the back one. */
  cameraId?: string
): Promise<void> {
  // Browsers only hand out a camera to a secure page. Over plain http - the
  // dev server opened by a phone at its LAN address - getUserMedia does not
  // even exist, and the scan failed with nothing that said why.
  if (typeof window !== "undefined" && !window.isSecureContext) {
    throw new Error("The camera only works over HTTPS. Open Awful.chat at an https:// address to scan.");
  }
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("This browser has no camera access.");
  await stopQrScan();
  const host = document.getElementById(elementId);
  if (!host) throw new Error("Scanner view is gone");

  let stream: MediaStream;
  if (scannerState.cameras.length === 0) {
    // The first getUserMedia is what raises the permission prompt, and it
    // does not resolve until the user has answered it - so this, and only
    // this, is the window in which the view should say it is waiting.
    scannerState.awaitingPermission = true;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(cameraId ?? null) });
    } finally {
      scannerState.awaitingPermission = false;
    }
    // Labels, and so the front/back choice, only exist once permission is in.
    scannerState.cameras = await listCameras();
    const best = cameraId ?? preferBackCamera(scannerState.cameras);
    const opened = stream.getVideoTracks()[0]?.getSettings().deviceId;
    if (best && opened && best !== opened) {
      // facingMode is a hint the browser may ignore - on several Androids it
      // opened the front camera. Now there is a list, open the one chosen.
      for (const t of stream.getTracks()) t.stop();
      stream = await navigator.mediaDevices.getUserMedia({ video: videoConstraints(best) });
    }
  } else {
    stream = await navigator.mediaDevices.getUserMedia({
      video: videoConstraints(cameraId ?? preferBackCamera(scannerState.cameras)),
    });
  }
  const track = stream.getVideoTracks()[0];
  scannerState.activeCameraId = track?.getSettings().deviceId ?? cameraId ?? null;

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.setAttribute("playsinline", "");
  video.srcObject = stream;
  // The front camera shown as a mirror, like every camera app does.
  const front = cameraFacing(scannerState.cameras.find((c) => c.id === scannerState.activeCameraId)) === "front";
  video.className = `block w-full ${front ? "-scale-x-100" : ""}`;
  host.replaceChildren(video);

  const session: Session = { element: elementId, stream, video, timer: null, stopped: false };
  _session = session;
  try {
    await video.play();
  } catch (err) {
    if (_session === session) await stopQrScan();
    throw err;
  }

  try {
    const caps = (track?.getCapabilities?.() ?? {}) as { torch?: boolean };
    scannerState.torchAvailable = caps.torch === true;
  } catch {
    scannerState.torchAvailable = false;
  }
  scannerState.torchOn = false;

  const detector = await nativeDetector();
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d", { willReadFrequently: true });

  const scan = async () => {
    if (session.stopped) return;
    let text: string | null = null;
    try {
      if (video.readyState >= 2 && video.videoWidth > 0) {
        if (detector) {
          text = (await detector.detect(video))[0]?.rawValue ?? null;
        } else if (context) {
          const scale = Math.min(1, MAX_DECODE_SIDE / Math.max(video.videoWidth, video.videoHeight));
          canvas.width = Math.round(video.videoWidth * scale);
          canvas.height = Math.round(video.videoHeight * scale);
          context.drawImage(video, 0, 0, canvas.width, canvas.height);
          const image = context.getImageData(0, 0, canvas.width, canvas.height);
          text = jsQR(image.data, image.width, image.height, { inversionAttempts: "attemptBoth" })?.data ?? null;
        }
      }
    } catch {
      // A frame that could not be read; the next one will be.
    }
    if (session.stopped) return;
    if (text && onText(text)) {
      if (_session === session) await stopQrScan();
      return;
    }
    session.timer = setTimeout(() => void scan(), SCAN_INTERVAL_MS);
  };
  void scan();
}

/** Switch the running camera's torch. Silently does nothing without one. */
export async function toggleScanTorch(): Promise<void> {
  const track = _session?.stream.getVideoTracks()[0];
  if (!track || !scannerState.torchAvailable) return;
  const next = !scannerState.torchOn;
  try {
    await track.applyConstraints({ advanced: [{ torch: next } as MediaTrackConstraintSet] });
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
  const session = _session;
  if (!session || (elementId !== undefined && elementId !== session.element)) {
    if (!session) scannerState.awaitingPermission = false;
    return;
  }
  _session = null;
  session.stopped = true;
  if (session.timer) clearTimeout(session.timer);
  const track = session.stream.getVideoTracks()[0];
  // Off before the stop: some Androids leave the torch burning after the
  // camera is released, and nothing in the app can reach it again.
  if (scannerState.torchOn && track) {
    try {
      await track.applyConstraints({ advanced: [{ torch: false } as MediaTrackConstraintSet] });
    } catch {
      // Nothing more to try; stopping the track releases the device anyway.
    }
  }
  for (const t of session.stream.getTracks()) t.stop();
  session.video.srcObject = null;
  session.video.remove();
  scannerState.awaitingPermission = false;
  scannerState.torchAvailable = false;
  scannerState.torchOn = false;
  // cameras and activeCameraId deliberately survive: a camera switch stops
  // and restarts, and re-enumerating would re-prompt on some browsers.
}
