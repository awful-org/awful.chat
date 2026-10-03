import { describe, expect, it, vi } from "vitest";
import {
  animatedView,
  canDecodeStillFrame,
  dataUrlImageSize,
  declaredImageSize,
  isSaneDimension,
  mediaBoxStyle,
  profileImageFits,
  stillFrameGrows,
  stillFrameRedraw,
  stillFrameSize,
} from "./image-size";
import { bytesToBase64 } from "./utils";

describe("isSaneDimension", () => {
  it("takes ordinary pixel counts", () => {
    expect(isSaneDimension(1)).toBe(true);
    expect(isSaneDimension(4032)).toBe(true);
  });

  it("refuses what a hostile peer could put in an aspect-ratio", () => {
    // These arrive inside a signed message, which proves the sender and
    // nothing about their honesty.
    for (const bad of [0, -5, 1e9, 20001, 1.5, NaN, Infinity, "800", null, undefined]) {
      expect(isSaneDimension(bad)).toBe(false);
    }
  });
});

describe("mediaBoxStyle", () => {
  it("holds a box for a video too, not only an image", () => {
    // A video with no dimensions lays out as the browser's default 300x150
    // and resizes when metadata lands, which is the same shift an image has.
    expect(mediaBoxStyle(1920, 1080)).toBe(
      "width: 20.000rem; aspect-ratio: 1920 / 1080;"
    );
  });

  it("is empty when the dimensions are missing, so nothing changes", () => {
    expect(mediaBoxStyle(undefined, undefined)).toBe("");
    expect(mediaBoxStyle(800, undefined)).toBe("");
  });

  it("is empty for out-of-range dimensions rather than emitting them", () => {
    expect(mediaBoxStyle(1e9, 1e9)).toBe("");
    expect(mediaBoxStyle(-800, 600)).toBe("");
  });

  it("lets height bind for a tall image", () => {
    // 600x1200 at 14rem tall is 7rem wide, well inside the 20rem limit.
    expect(mediaBoxStyle(600, 1200)).toBe(
      "width: 7.000rem; aspect-ratio: 600 / 1200;"
    );
  });

  it("never enlarges a picture past its own size", () => {
    // The limits are a ceiling, not a target. A 64x64 avatar used to render
    // at 64; blowing it up to the 224px box just makes it blurry.
    expect(mediaBoxStyle(64, 64)).toBe(
      "width: 4.000rem; aspect-ratio: 64 / 64;"
    );
  });

  it("refuses a ratio absurd enough to be a sliver", () => {
    // Both numbers are inside the pixel bounds; the RATIO is the attack.
    expect(mediaBoxStyle(20000, 1)).toBe("");
    expect(mediaBoxStyle(1, 20000)).toBe("");
  });

  it("lets width bind for a wide image", () => {
    // 4000x1000 would want 56rem on height alone; the 20rem cap wins.
    expect(mediaBoxStyle(4000, 1000)).toBe(
      "width: 20.000rem; aspect-ratio: 4000 / 1000;"
    );
  });

  it("carries the true ratio, not a rounded one", () => {
    // The style is what stops the reflow, so the box has to match the image
    // exactly - a rounded ratio moves the content by a pixel or two on load.
    expect(mediaBoxStyle(1023, 767)).toContain("aspect-ratio: 1023 / 767;");
  });
});

const text = (s: string) => [...s].map((c) => c.charCodeAt(0));
const le16 = (n: number) => [n & 0xff, (n >> 8) & 0xff];
const le24 = (n: number) => [n & 0xff, (n >> 8) & 0xff, (n >> 16) & 0xff];
const be16 = (n: number) => [(n >> 8) & 0xff, n & 0xff];
const be32 = (n: number) => [n >>> 24, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];

/** A GIF with a colour table, two extensions, and a first frame if given. */
function gif(w: number, h: number, frame?: [number, number]): number[] {
  return [
    ...text("GIF89a"), ...le16(w), ...le16(h), 0x80, 0, 0,
    0, 0, 0, 255, 255, 255,
    0x21, 0xf9, 4, 0, 0, 0, 0, 0,
    0x21, 0xfe, 3, ...text("hi!"), 0,
    ...(frame ? [0x2c, ...le16(0), ...le16(0), ...le16(frame[0]), ...le16(frame[1]), 0] : []),
    0x3b,
  ];
}

function png(w: number, h: number): number[] {
  return [0x89, ...text("PNG\r\n\x1a\n"), ...be32(13), ...text("IHDR"), ...be32(w), ...be32(h), 8, 6, 0, 0, 0];
}

const RIFF = [...text("RIFF"), 0, 0, 0, 0, ...text("WEBP")];
const webpExtended = (w: number, h: number) =>
  [...RIFF, ...text("VP8X"), 10, 0, 0, 0, 0x10, 0, 0, 0, ...le24(w - 1), ...le24(h - 1)];
const webpLossy = (w: number, h: number) =>
  [...RIFF, ...text("VP8 "), 0, 0, 0, 0, 0, 0, 0, 0x9d, 0x01, 0x2a, ...le16(w), ...le16(h)];
function webpLossless(w: number, h: number): number[] {
  const bits = (w - 1) | ((h - 1) << 14);
  return [...RIFF, ...text("VP8L"), 0, 0, 0, 0, 0x2f, ...le24(bits), bits >>> 24, 0, 0, 0, 0, 0];
}

/**
 * A JPEG whose frame header sits behind `exif` APP1 segments of the most
 * a segment holds, each carrying a thumbnail's own 16x16 frame header.
 */
function jpeg(w: number, h: number, exif = 0): number[] {
  const out = [0xff, 0xd8];
  for (let k = 0; k < exif; k++) {
    const data = new Array<number>(65533).fill(0);
    data.splice(0, 9, 0xff, 0xc0, 0x00, 0x11, 8, ...be16(16), ...be16(16));
    out.push(0xff, 0xe1, ...be16(65535), ...data);
  }
  out.push(0xff, 0xdb, ...be16(67), ...new Array<number>(65).fill(1));
  // A fill byte, then a progressive frame header.
  out.push(0xff, 0xff, 0xc2, ...be16(17), 8, ...be16(h), ...be16(w), 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  out.push(0xff, 0xda, ...be16(12), 3, 1, 0, 2, 0x11, 3, 0x11, 0, 63, 0, 0xff, 0xd9);
  return out;
}

const reader = (b: number[]) => (i: number) => (i < b.length ? b[i] : -1);
const dataUrl = (mime: string, b: number[]) => `data:${mime};base64,${bytesToBase64(Uint8Array.from(b))}`;

describe("declaredImageSize", () => {
  it("reads the size each format declares", () => {
    expect(declaredImageSize(reader(gif(300, 200)))).toEqual({ width: 300, height: 200 });
    expect(declaredImageSize(reader(png(256, 256)))).toEqual({ width: 256, height: 256 });
    expect(declaredImageSize(reader(webpExtended(840, 360)))).toEqual({ width: 840, height: 360 });
    expect(declaredImageSize(reader(webpLossy(640, 480)))).toEqual({ width: 640, height: 480 });
    expect(declaredImageSize(reader(webpLossless(100, 50)))).toEqual({ width: 100, height: 50 });
    expect(declaredImageSize(reader(jpeg(640, 480)))).toEqual({ width: 640, height: 480 });
  });

  it("grows a GIF's screen to fit its first frame, as browsers do", () => {
    expect(declaredImageSize(reader(gif(1, 1, [16383, 16383])))).toEqual({ width: 16383, height: 16383 });
    expect(declaredImageSize(reader(gif(500, 400, [10, 10])))).toEqual({ width: 500, height: 400 });
  });

  it("finds a JPEG's frame behind padded EXIF, not the thumbnail inside it", () => {
    expect(declaredImageSize(reader(jpeg(4000, 3000, 2)))).toEqual({ width: 4000, height: 3000 });
  });

  it("is null for a format it does not read, or a header cut short", () => {
    const avif = [0, 0, 0, 0x1c, ...text("ftypavif"), 0, 0, 0, 0];
    for (const bytes of [avif, [0, 0, 0], png(1, 1).slice(0, 8), gif(1, 1).slice(0, 8), jpeg(1, 1).slice(0, 40)]) {
      expect(declaredImageSize(reader(bytes))).toBeNull();
    }
  });
});

describe("dataUrlImageSize", () => {
  it("reads the size through base64", () => {
    expect(dataUrlImageSize(dataUrl("image/gif", gif(1, 1, [16383, 16383])))).toEqual({ width: 16383, height: 16383 });
    expect(dataUrlImageSize(dataUrl("image/jpeg", jpeg(4000, 3000, 2)))).toEqual({ width: 4000, height: 3000 });
    // The type a data: URL claims is not what a browser draws by.
    expect(dataUrlImageSize(dataUrl("image/gif", png(9000, 9000)))).toEqual({ width: 9000, height: 9000 });
    expect(dataUrlImageSize("data:image/png;base64,iVBORw0KGgo=")).toBeNull();
  });

  it("decodes only what the header walk reads, not the picture", () => {
    const big = dataUrl("image/png", [...png(256, 256), ...new Array<number>(1_000_000).fill(0)]);
    const atob = vi.spyOn(globalThis, "atob");
    try {
      expect(dataUrlImageSize(big)).toEqual({ width: 256, height: 256 });
      const decoded = atob.mock.calls.reduce((n, [chars]) => n + String(chars).length, 0);
      expect(decoded).toBeLessThanOrEqual(4096);
    } finally {
      atob.mockRestore();
    }
  });
});

describe("profileImageFits", () => {
  it("takes what the picker sends, and what it cannot read", () => {
    expect(profileImageFits(dataUrl("image/webp", webpExtended(256, 256)))).toBe(true);
    expect(profileImageFits(dataUrl("image/gif", gif(840, 360, [840, 360])))).toBe(true);
    expect(profileImageFits(dataUrl("image/jpeg", jpeg(4032, 3024)))).toBe(true);
    expect(profileImageFits("data:image/avif;base64,AAAAHGZ0eXBhdmlm")).toBe(true);
  });

  it("refuses a few bytes that claim to decode to a gigabyte", () => {
    for (const url of [
      dataUrl("image/gif", gif(16383, 16383)),
      dataUrl("image/gif", gif(1, 1, [16383, 16383])),
      dataUrl("image/png", png(16383, 16383)),
      dataUrl("image/webp", webpExtended(14000, 14000)),
      dataUrl("image/jpeg", jpeg(5000, 100, 2)),
    ]) {
      expect(profileImageFits(url), url.slice(0, 40)).toBe(false);
    }
  });
});

/** Where an unsized canvas lays out under max-w-xs max-h-56: its own shape, shrunk to fit. */
function fitMessageBox(w: number, h: number) {
  const scale = Math.min(1, 320 / w, 224 / h);
  return { width: w * scale, height: h * scale };
}

describe("stillFrameSize", () => {
  it("covers the box an avatar is shown in, and no more", () => {
    expect(stillFrameSize(4000, 3000, 32, 32, 2)).toEqual({ width: 85, height: 64 });
    expect(stillFrameSize(256, 256, 40, 40, 1)).toEqual({ width: 40, height: 40 });
  });

  it("never draws more than the image has", () => {
    expect(stillFrameSize(100, 100, 500, 500, 2)).toEqual({ width: 100, height: 100 });
  });

  it("caps a side when the box is not known", () => {
    expect(stillFrameSize(3000, 2000, 0, 0, 1)).toEqual({ width: 1024, height: 683 });
  });

  it("refuses an image too large to decode for a still frame", () => {
    expect(canDecodeStillFrame(4096, 4096)).toBe(true);
    expect(canDecodeStillFrame(16383, 16383)).toBe(false);
    expect(canDecodeStillFrame(0, 10)).toBe(false);
    expect(stillFrameSize(16383, 16383, 32, 32, 1)).toBeNull();
  });

  it("keeps a GIF in a message the size it was, and every canvas small", () => {
    // Unsized, the canvas lays out at its own size: the frame must still
    // fill the box the animated img takes when it plays.
    for (let k = 0; k < 2000; k++) {
      const w = 1 + Math.floor(Math.random() * 4096);
      const h = 1 + Math.floor(Math.random() * 4096);
      const ratio = [1, 1.5, 2, 3][k % 4];
      const shown = fitMessageBox(w, h);
      const frame = stillFrameSize(w, h, shown.width, shown.height, ratio)!;
      const drawn = fitMessageBox(frame.width, frame.height);
      expect(Math.abs(drawn.width - shown.width), `${w}x${h}@${ratio}`).toBeLessThanOrEqual(1);
      expect(Math.abs(drawn.height - shown.height), `${w}x${h}@${ratio}`).toBeLessThanOrEqual(1);
      expect(Math.max(frame.width, frame.height)).toBeLessThanOrEqual(1024);
    }
  });
});

describe("stillFrameGrows", () => {
  it("draws the first frame, and again only when the box needs more pixels", () => {
    expect(stillFrameGrows(undefined, { width: 64, height: 64 })).toBe(true);
    // Past a breakpoint, or zoomed in: more pixels either way.
    expect(stillFrameGrows({ width: 64, height: 64 }, { width: 80, height: 80 })).toBe(true);
    expect(stillFrameGrows({ width: 64, height: 48 }, { width: 64, height: 50 })).toBe(true);
    // Smaller or the same keeps the frame it has.
    expect(stillFrameGrows({ width: 64, height: 64 }, { width: 40, height: 40 })).toBe(false);
    expect(stillFrameGrows({ width: 64, height: 64 }, { width: 64, height: 64 })).toBe(false);
  });

  it("settles after the frame it draws moves the box", () => {
    // A GIF in a message lays out at its canvas's size: each redraw resizes
    // the canvas, and so the box it is measured from again.
    for (const ratio of [1, 1.5, 2, 3]) {
      const shown = fitMessageBox(1200, 900);
      let drawn: { width: number; height: number } | undefined;
      let draws = 0;
      for (let pass = 0; pass < 5; pass++) {
        const needed = stillFrameSize(1200, 900, shown.width, shown.height, ratio)!;
        if (!stillFrameGrows(drawn, needed)) break;
        drawn = needed;
        draws++;
        Object.assign(shown, fitMessageBox(drawn.width, drawn.height));
      }
      expect(draws, `@${ratio}`).toBe(1);
    }
  });
});

describe("animatedView", () => {
  it("plays nothing until the image's size is known, and nothing past the bound", () => {
    // GifImage mounts the img that plays only for "shown": the browser
    // decodes that img at full size, so a peer's GIF link that claims
    // 16383x16383 must never get one, nor one not yet checked.
    expect(animatedView(undefined)).toBe("loading");
    expect(animatedView(null)).toBe("failed");
    expect(animatedView({ width: 498, height: 280 })).toBe("shown");
    expect(animatedView({ width: 4096, height: 4096 })).toBe("shown");
    expect(animatedView({ width: 16383, height: 16383 })).toBe("too-large");
    expect(animatedView({ width: 4097, height: 4096 })).toBe("too-large");
    expect(animatedView({ width: 1, height: 16_777_217 })).toBe("too-large");
  });
});

describe("stillFrameRedraw", () => {
  it("keeps the frame it has while its canvas is hidden", () => {
    // A 4096x4096 avatar in a 40px box at ratio 2: an 80x80 frame.
    const first = stillFrameRedraw(undefined, 4096, 4096, 40, 40, 2);
    expect(first).toEqual({ width: 80, height: 80 });
    // display:none measures the canvas at 0x0. Read as no box, that drew
    // the image at 1024x1024, 4 MB, and kept it once shown again.
    expect(stillFrameRedraw(first!, 4096, 4096, 0, 0, 2)).toBeNull();
    expect(stillFrameRedraw(first!, 4096, 4096, 0, 40, 2)).toBeNull();
    expect(stillFrameRedraw(first!, 4096, 4096, 40, 40, 2)).toBeNull();
    // A box that grows still gets more pixels.
    expect(stillFrameRedraw(first!, 4096, 4096, 80, 80, 2)).toEqual({ width: 160, height: 160 });
  });

  it("draws a first frame for a canvas not laid out yet, as before", () => {
    expect(stillFrameRedraw(undefined, 4096, 4096, 0, 0, 2)).toEqual({ width: 1024, height: 1024 });
  });
});
