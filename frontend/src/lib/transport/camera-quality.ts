/**
 * How a camera is captured and sent, and which of its levels a viewer asks
 * the SFU for.
 *
 * A camera goes out as three levels at once (simulcast): a quarter, half and
 * full size of what is captured. The SFU hands each viewer the best one their
 * own connection carries, and a viewer asks for no more than its tile needs.
 * Sent as one stream, as it was before, every viewer got the same picture:
 * one on a weak link lost it, and a small tile was sent a full 720p it never
 * showed.
 */

/** Levels per camera, smallest first. The SFU numbers them 0 to 2. */
export const CAMERA_LAYERS = 3;
/** The full-size level. A viewer that says nothing about size gets it. */
export const TOP_LAYER = CAMERA_LAYERS - 1;

/**
 * What to capture. 1080p on a computer. 720p on a phone or tablet: encoding
 * three levels of 1080p heats one up and drains it, and a phone's front
 * camera at 1080p is often a crop of the same sensor area anyway. `ideal`
 * throughout, so a camera that cannot do it gives the nearest it can.
 */
export function cameraCaptureConstraints(
  handheld: boolean
): MediaTrackConstraints {
  return handheld
    ? { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } }
    : { width: { ideal: 1920 }, height: { ideal: 1080 }, frameRate: { ideal: 30 } };
}

/**
 * Open the chosen camera at these constraints.
 *
 * The device is asked for `exact` first. As `ideal` it is only one of the
 * things the browser weighs: a 640x480 webcam is further from a 1920x1080
 * ideal than a different camera that is 1080p, so the chosen one lost to
 * whichever other camera fit the size better. A camera since unplugged (or a
 * phone no longer offering itself) fails `exact`, and then whatever camera
 * is there is opened rather than none. A refused permission is not retried.
 */
export async function openCamera(
  deviceId: string | null,
  video: MediaTrackConstraints,
  audio: MediaStreamConstraints["audio"] = false,
  media: Pick<MediaDevices, "getUserMedia"> = navigator.mediaDevices
): Promise<MediaStream> {
  if (deviceId) {
    try {
      return await media.getUserMedia({ video: { ...video, deviceId: { exact: deviceId } }, audio });
    } catch (err) {
      const name = err instanceof Error ? err.name : "";
      if (name !== "OverconstrainedError" && name !== "NotFoundError") throw err;
    }
  }
  return media.getUserMedia({
    video: deviceId ? { ...video, deviceId: { ideal: deviceId } } : video,
    audio,
  });
}

/** A touch screen as the main input: phones and tablets. */
export function isHandheld(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof window.matchMedia === "function" &&
    window.matchMedia("(pointer: coarse)").matches
  );
}

/**
 * The most a level may use, from its short side in pixels. Close to what
 * Meet and Jitsi give a camera of that size: enough to stay sharp at 30 fps
 * with ordinary motion, not so much that the top level crowds out the others
 * on an average uplink.
 */
export function layerBitrate(shortSide: number): number {
  if (shortSide >= 1000) return 2_500_000;
  if (shortSide >= 700) return 1_500_000;
  if (shortSide >= 500) return 800_000;
  if (shortSide >= 340) return 450_000;
  if (shortSide >= 250) return 250_000;
  return 150_000;
}

/**
 * How many levels Chrome sends for a capture of this many pixels. It sends
 * no more than this whatever it is asked, and drops the LARGEST ones to get
 * there: a 640x480 camera asked for three levels sent only its quarter and
 * half sizes. So a smaller capture asks for fewer levels, and its full size
 * stays among them. Chrome's own table (simulcast.cc), by pixel count.
 */
export function layerCount(width: number, height: number): number {
  const pixels = width * height;
  if (pixels >= 960 * 540) return 3;
  if (pixels >= 480 * 270) return 2;
  return 1;
}

/**
 * The levels for a track captured at width x height: a quarter, half and
 * full size, or the larger of those that fit (layerCount). Smallest first,
 * the order mediasoup expects. L1T3 also splits each level into three frame
 * rates, so the SFU can drop to 15 or 7.5 fps for a viewer before it has to
 * drop a size. A track that does not say its size is taken as 720p.
 */
export function cameraEncodings(
  width: number,
  height: number
): RTCRtpEncodingParameters[] {
  if (!width || !height) [width, height] = [1280, 720];
  const shortSide = Math.min(width, height);
  const scales = [4, 2, 1].slice(CAMERA_LAYERS - layerCount(width, height));
  return scales.map((scale) => ({
    scaleResolutionDownBy: scale,
    maxBitrate: layerBitrate(shortSide / scale),
    maxFramerate: 30,
    scalabilityMode: "L1T3",
  })) as RTCRtpEncodingParameters[];
}

/**
 * The level a tile needs, from its long side in CSS pixels; null is a
 * surface whose size is not measured (the floating panel, picture in
 * picture, a window of its own), which gets the top.
 *
 * Measured against a 720p sender, whose levels are 320, 640 and 1280 pixels
 * on the long side: a 1080p sender's levels are larger, so the same choice
 * still covers the tile. A sender with fewer levels has larger ones too: the
 * SFU counts them from the smallest it has, and gives the largest it has for
 * a level past it. The screen's pixel ratio counts up to 2, past which
 * a phone would ask for the top level in any tile.
 */
export function layerForTile(longSide: number | null, pixelRatio = 1): number {
  if (longSide === null) return TOP_LAYER;
  const needed = longSide * Math.min(Math.max(pixelRatio, 1), 2);
  if (needed <= 320) return 0;
  if (needed <= 640) return 1;
  return TOP_LAYER;
}

/**
 * Each shown camera's displayed size: the largest it is shown at, or null
 * when it is also shown somewhere that cannot be measured (see layerForTile).
 * A shown camera with no size yet is null too: it gets the top until one is
 * known.
 */
export function cameraDisplaySizes(
  wanted: Iterable<string>,
  unmeasured: ReadonlySet<string>,
  measured: Iterable<readonly [peerId: string, longSide: number]>
): Map<string, number | null> {
  const largest = new Map<string, number>();
  for (const [peerId, size] of measured) {
    largest.set(peerId, Math.max(largest.get(peerId) ?? 0, size));
  }
  const sizes = new Map<string, number | null>();
  for (const peerId of wanted) {
    const size = largest.get(peerId);
    sizes.set(peerId, unmeasured.has(peerId) || !size ? null : size);
  }
  return sizes;
}
