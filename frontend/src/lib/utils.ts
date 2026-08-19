import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChild<T> = T extends { child?: any } ? Omit<T, "child"> : T;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type WithoutChildren<T> = T extends { children?: any }
  ? Omit<T, "children">
  : T;
export type WithoutChildrenOrChild<T> = WithoutChildren<WithoutChild<T>>;
export type WithElementRef<T, U extends HTMLElement = HTMLElement> = T & {
  ref?: U | null;
};

/** Encode a Uint8Array to a lowercase hex string. */
export function hex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** Decode a hex string to a Uint8Array. Throws on odd-length input. */
export function unhex(h: string): Uint8Array<ArrayBuffer> {
  if (h.length % 2 !== 0) throw new Error("Invalid hex string length");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** Encode a UTF-8 string to a Uint8Array. */
export function utf8(s: string): Uint8Array<ArrayBuffer> {
  return new TextEncoder().encode(s);
}

export function encode(obj: unknown): Uint8Array {
  return new TextEncoder().encode(JSON.stringify(obj));
}

export function decode(data: Uint8Array): unknown {
  return JSON.parse(new TextDecoder().decode(data));
}

/** Base64 raster image, no svg+xml: SVG can carry script and external refs. */
const DATA_AVATAR_RE =
  /^data:image\/(png|jpeg|jpg|gif|webp|avif);base64,[A-Za-z0-9+/]+=*$/;

/** ~1.4 MB of base64, i.e. about a 1 MB image. */
const MAX_DATA_AVATAR_LEN = 1_400_000;

/**
 * Only 6-digit hex colors survive. Nickname colors end up in inline style
 * attributes, so anything wider (CSS expressions, url(), named colors) is
 * rejected instead of trusted from the wire.
 */
const NICKNAME_COLOR_RE = /^#[0-9a-fA-F]{6}$/;

export function normalizeNicknameColor(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  return NICKNAME_COLOR_RE.test(value) ? value.toLowerCase() : undefined;
}

export function normalizeAvatarUrl(url: unknown): string | undefined {
  if (typeof url !== "string") return undefined;
  // An avatar picked from the device is sent inline as a data: URL - rejecting
  // those meant uploaded pictures never propagated to anyone, only linked ones.
  if (url.startsWith("data:")) {
    if (url.length > MAX_DATA_AVATAR_LEN) return undefined;
    return DATA_AVATAR_RE.test(url) ? url : undefined;
  }
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return undefined;
    return parsed.toString();
  } catch {
    return undefined;
  }
}
