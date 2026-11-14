import { callGridRects, callLayoutGroups, cameraStripGeometry, createCameraStripState, filterCallTiles, selectCameraStrip, type CameraStripState, type CallLayoutPrefs, type LayoutRect } from "./call-layout";
import type { SpotlightTile } from "./spotlight";

export interface PipTile extends SpotlightTile { label: string }
export interface PipLayout {
  tiles: PipTile[];
  prefs: CallLayoutPrefs;
  pin: string | null;
  speaker: string | null;
  speaking: ReadonlySet<string>;
  lastSpokeAt?: ReadonlyMap<string, number>;
}

/** The same grouping, filters and strip constraints as the main call stage. */
export function pipLayoutCells(layout: PipLayout, width: number, height: number, previous = createCameraStripState()) {
  const groups = callLayoutGroups(filterCallTiles(layout.tiles, layout.prefs), layout.prefs, layout.pin, layout.speaker, layout.speaking);
  const strip = cameraStripGeometry(width, height, layout.prefs, groups.strip.length);
  const rects = callGridRects(groups.main.length, groups.grid ? width : strip.mainW, groups.grid ? height : strip.mainH);
  const offset = groups.grid ? 0 : strip.mainY;
  const cells = groups.main.map((tile, i) => ({ tile, rect: { ...rects[i], y: rects[i].y + offset } }));
  const stripState = selectCameraStrip(previous, groups.strip, strip.shown, layout.speaking, layout.lastSpokeAt);
  if (!groups.grid) {
    stripState.ids.forEach((id, i) => {
      const tile = groups.strip.find((tile) => tile.id === id)!;
      cells.push({ tile, rect: stripRect(i) });
    });
  }
  function stripRect(i: number): LayoutRect {
    return { x: strip.side ? strip.mainW + 8 : i * (strip.tileW + 8), y: strip.side ? i * (strip.tileH + 8) : strip.stripY, w: strip.tileW, h: strip.tileH };
  }
  return { cells, stripState, overflow: !groups.grid && strip.more ? { count: strip.more, rect: stripRect(strip.shown) } : null };
}

// All PiP paths use a composed stream: even browsers offering only video PiP
// inherit the layout. Each surface has its own bounds, stable output stream and
// decoders; resizing or changing a filter never remounts the PiP video.
let current: PipLayout | null = null;
let reportCameras: (peers: string[]) => void = () => {};
const surfaces = new Set<ReturnType<typeof createSurface>>();

export function setPipLayout(layout: PipLayout | null, onCameras: (peers: string[]) => void): void {
  current = layout;
  reportCameras = onCameras;
  for (const surface of surfaces) surface.update();
  reportVisibleCameras();
}

function reportVisibleCameras(): void {
  reportCameras([...new Set([...surfaces].flatMap((s) => s.cameraPeers()))]);
}

export interface PipVideoOptions { width: number; height: number; active?: boolean }

/** Svelte action, also used directly by the Document PiP window. */
export function pipLayoutVideo(video: HTMLVideoElement, options: PipVideoOptions) {
  const surface = createSurface(video, options);
  surfaces.add(surface);
  surface.update();
  reportVisibleCameras();
  return {
    update(next: PipVideoOptions) { surface.resize(next); reportVisibleCameras(); },
    destroy() { surfaces.delete(surface); surface.destroy(); reportVisibleCameras(); },
  };
}

function createSurface(output: HTMLVideoElement, initial: PipVideoOptions) {
  const doc = output.ownerDocument;
  const canvas = doc.createElement("canvas");
  const ctx = canvas.getContext("2d")!;
  let options = initial;
  let stripState: CameraStripState = createCameraStripState();
  let cells: Pick<ReturnType<typeof pipLayoutCells>, "cells" | "overflow"> = { cells: [], overflow: null };
  const sources = new Map<string, { track: MediaStreamTrack; video: HTMLVideoElement }>();
  let timer: number | undefined;
  let nativeWindow: PictureInPictureWindow | null = null;
  const timerHost = doc.defaultView ?? window;
  // Capture only our canvas track. Never stop the source call's media tracks.
  canvas.width = Math.max(1, Math.round(options.width * 2));
  canvas.height = Math.max(1, Math.round(options.height * 2));
  const stream = canvas.captureStream(30);
  output.srcObject = stream;

  function draw() {
    const { width, height } = options;
    ctx.setTransform(2, 0, 0, 2, 0, 0);
    ctx.fillStyle = "#09090b";
    ctx.fillRect(0, 0, width, height);
    for (const { tile, rect } of cells.cells) {
      const { x, y, w, h } = rect;
      if (w <= 0 || h <= 0) continue;
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.fillStyle = "#18181b";
      ctx.fillRect(x, y, w, h);
      const source = sources.get(tile.id)?.video;
      if (source && source.readyState >= 2 && source.videoWidth && source.videoHeight) {
        const scale = tile.kind === "camera" ? Math.max(w / source.videoWidth, h / source.videoHeight) : Math.min(w / source.videoWidth, h / source.videoHeight);
        const dw = source.videoWidth * scale, dh = source.videoHeight * scale;
        ctx.drawImage(source, x + (w - dw) / 2, y + (h - dh) / 2, dw, dh);
      } else {
        ctx.fillStyle = "#e4e4e7";
        ctx.textAlign = "center";
        ctx.font = `${Math.max(12, Math.min(32, h / 3))}px system-ui`;
        ctx.fillText(tile.kind === "camera" ? tile.label.charAt(0).toUpperCase() : tile.kind === "plugin" ? "Open app in call" : "Connecting…", x + w / 2, y + h / 2, Math.max(0, w - 8));
      }
      const fontSize = Math.max(9, Math.min(12, h / 5));
      ctx.fillStyle = "#000a";
      ctx.fillRect(x, y + h - fontSize - 8, w, fontSize + 8);
      ctx.textAlign = "left";
      ctx.font = `${fontSize}px system-ui`;
      ctx.fillStyle = "#fff";
      const status = tile.kind === "screen" || tile.kind === "transmission" ? "sharing" : current?.speaking.has(tile.peerId) ? "speaking" : "";
      ctx.fillText(status ? `${tile.label} · ${status}` : tile.label, x + 4, y + h - 5, Math.max(0, w - 8));
      if (current?.speaking.has(tile.peerId)) {
        ctx.strokeStyle = "#24f29a";
        ctx.lineWidth = 2;
        ctx.strokeRect(x + 1, y + 1, Math.max(0, w - 2), Math.max(0, h - 2));
      }
      ctx.restore();
    }
    if (cells.overflow) {
      const { rect: r, count } = cells.overflow;
      ctx.fillStyle = "#27272a";
      ctx.fillRect(r.x, r.y, r.w, r.h);
      ctx.fillStyle = "#fff";
      ctx.textAlign = "center";
      ctx.font = "12px system-ui";
      ctx.fillText(`+${count}`, r.x + r.w / 2, r.y + r.h / 2 + 4);
    }
    if (!cells.cells.length && current) {
      ctx.fillStyle = "#a1a1aa";
      ctx.textAlign = "center";
      ctx.font = "12px system-ui";
      ctx.fillText("No tiles shown · change Layout in call", width / 2, height / 2, Math.max(0, width - 16));
    }
  }

  function update() {
    if (current) {
      const next = pipLayoutCells(current, options.width, options.height, stripState);
      stripState = next.stripState;
      cells = next;
    } else {
      stripState = createCameraStripState();
      cells = { cells: [], overflow: null };
    }
    const live = new Set(cells.cells.map(({ tile }) => tile.id));
    for (const [id, source] of sources) {
      const tile = cells.cells.find((c) => c.tile.id === id)?.tile;
      if (!options.active || !live.has(id) || tile?.videoTrack !== source.track) {
        source.video.pause();
        source.video.srcObject = null;
        source.video.onloadeddata = null;
        sources.delete(id);
      }
    }
    for (const { tile } of cells.cells) {
      if (!options.active || !tile.videoTrack || sources.has(tile.id)) continue;
      const video = doc.createElement("video");
      video.muted = true;
      video.autoplay = true;
      video.playsInline = true;
      video.srcObject = new MediaStream([tile.videoTrack]);
      video.onloadeddata = draw;
      void video.play().catch(() => {});
      sources.set(tile.id, { track: tile.videoTrack, video });
    }
    if (timer) timerHost.clearInterval(timer);
    timer = options.active ? timerHost.setInterval(draw, 1000 / 30) : undefined;
    draw();
  }

  function resize(next: PipVideoOptions) {
    options = next;
    canvas.width = Math.max(1, Math.round(next.width * 2));
    canvas.height = Math.max(1, Math.round(next.height * 2));
    update();
  }
  function nativeResize() {
    if (nativeWindow) { resize({ width: nativeWindow.width, height: nativeWindow.height, active: true }); reportVisibleCameras(); }
  }
  function enter(event: Event) {
    nativeWindow = (event as PictureInPictureEvent).pictureInPictureWindow;
    nativeWindow.addEventListener("resize", nativeResize);
    nativeResize();
  }
  function leave() {
    nativeWindow?.removeEventListener("resize", nativeResize);
    nativeWindow = null;
    resize(initial);
    reportVisibleCameras();
  }
  function presentationChanged() {
    const mode = (output as HTMLVideoElement & { webkitPresentationMode?: string }).webkitPresentationMode;
    resize({ ...initial, active: mode === "picture-in-picture" || !!initial.active });
    reportVisibleCameras();
  }
  output.addEventListener("enterpictureinpicture", enter);
  output.addEventListener("leavepictureinpicture", leave);
  output.addEventListener("webkitpresentationmodechanged", presentationChanged);
  return {
    update, resize,
    cameraPeers: () => options.active ? cells.cells.filter(({ tile }) => tile.kind === "camera" && !tile.isLocal).map(({ tile }) => tile.peerId) : [],
    destroy() {
      if (timer) timerHost.clearInterval(timer);
      nativeWindow?.removeEventListener("resize", nativeResize);
      output.removeEventListener("enterpictureinpicture", enter);
      output.removeEventListener("leavepictureinpicture", leave);
      output.removeEventListener("webkitpresentationmodechanged", presentationChanged);
      for (const source of sources.values()) { source.video.pause(); source.video.srcObject = null; source.video.onloadeddata = null; }
      stream.getTracks().forEach((track) => track.stop());
      if (output.srcObject === stream) output.srcObject = null;
    },
  };
}
