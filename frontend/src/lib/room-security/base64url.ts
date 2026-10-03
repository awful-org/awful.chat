/**
 * base64url without padding - the room channel's wire encoding - at native
 * speed.
 *
 * @scure/base's base64urlnopad is a pure-JS radix chain on every engine (its
 * fast path covers only the padded variants), and every room frame went
 * through it four times: the payload into the JSON body and the ciphertext
 * out, then both back on receipt. At ~130 ms/MiB to encode and ~60 ms/MiB to
 * decode, that was nearly all of what a profile with an uploaded avatar cost
 * to seal and open, on the main thread, once per copy.
 *
 * The output is byte for byte what base64urlnopad produces, and decoding
 * refuses exactly what it refuses: anything outside A-Z a-z 0-9 - _ (padding
 * and whitespace included), a length of 4n+1, and a last character whose
 * unused bits are not zero - so one value has exactly one encoding. The
 * engine's own decoder skips whitespace and ignores those bits, which is why
 * they are checked here before it runs.
 */

type Codec = {
  encode(bytes: Uint8Array): string;
  decode(text: string): Uint8Array;
};

/** Uint8Array.prototype.toBase64 / Uint8Array.fromBase64, not in lib.dom yet. */
type NativeEncode = {
  toBase64(options: { alphabet: "base64url"; omitPadding: boolean }): string;
};
type NativeDecode = {
  fromBase64(text: string, options: { alphabet: "base64url" }): Uint8Array;
};

const SHAPE = /^[A-Za-z0-9_-]*$/;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
/** Character code of each 6-bit value, and the value of each character code. */
const TO_CHAR = Uint8Array.from(ALPHABET, (c) => c.charCodeAt(0));
const FROM_CHAR = new Uint8Array(128);
for (let i = 0; i < 64; i++) FROM_CHAR[TO_CHAR[i]] = i;
const ascii = { encoder: new TextEncoder(), decoder: new TextDecoder() };

function assertBytes(bytes: Uint8Array): void {
  if (!(bytes instanceof Uint8Array)) throw new Error("Uint8Array expected");
}

function assertCanonical(text: string): void {
  if (typeof text !== "string" || !SHAPE.test(text)) throw new Error("Invalid base64url");
  const tail = text.length % 4;
  if (tail === 1) throw new Error("Invalid base64url length");
  // Two trailing characters carry one byte and four spare bits, three carry
  // two bytes and two spare bits.
  if (tail !== 0 && (FROM_CHAR[text.charCodeAt(text.length - 1)] & (tail === 2 ? 0x0f : 0x03)) !== 0) {
    throw new Error("Non-canonical base64url");
  }
}

/**
 * A lookup table over bytes, for engines without the built-in: about 3 ms a
 * MiB each way. Going round through btoa/atob instead - binary strings, then
 * swapping the alphabet's two odd characters - measured 19 ms to encode and
 * 11 to decode.
 */
export const portableBase64url: Codec = {
  encode(bytes) {
    assertBytes(bytes);
    const length = bytes.length;
    const whole = length - (length % 3);
    const out = new Uint8Array(Math.ceil((length * 4) / 3));
    let o = 0;
    for (let i = 0; i < whole; i += 3) {
      const v = (bytes[i] << 16) | (bytes[i + 1] << 8) | bytes[i + 2];
      out[o++] = TO_CHAR[v >> 18];
      out[o++] = TO_CHAR[(v >> 12) & 63];
      out[o++] = TO_CHAR[(v >> 6) & 63];
      out[o++] = TO_CHAR[v & 63];
    }
    if (length - whole === 1) {
      const v = bytes[whole] << 16;
      out[o++] = TO_CHAR[v >> 18];
      out[o++] = TO_CHAR[(v >> 12) & 63];
    } else if (length - whole === 2) {
      const v = (bytes[whole] << 16) | (bytes[whole + 1] << 8);
      out[o++] = TO_CHAR[v >> 18];
      out[o++] = TO_CHAR[(v >> 12) & 63];
      out[o++] = TO_CHAR[(v >> 6) & 63];
    }
    return ascii.decoder.decode(out);
  },
  decode(text) {
    assertCanonical(text);
    // Only ASCII is left after the check, so these are the character codes.
    const chars = ascii.encoder.encode(text);
    const length = chars.length;
    const whole = length - (length % 4);
    const out = new Uint8Array(Math.floor((length * 3) / 4));
    let o = 0;
    for (let i = 0; i < whole; i += 4) {
      const v = (FROM_CHAR[chars[i]] << 18) | (FROM_CHAR[chars[i + 1]] << 12) |
        (FROM_CHAR[chars[i + 2]] << 6) | FROM_CHAR[chars[i + 3]];
      out[o++] = v >> 16;
      out[o++] = (v >> 8) & 255;
      out[o++] = v & 255;
    }
    if (length - whole === 2) {
      out[o++] = (FROM_CHAR[chars[whole]] << 2) | (FROM_CHAR[chars[whole + 1]] >> 4);
    } else if (length - whole === 3) {
      const v = (FROM_CHAR[chars[whole]] << 12) | (FROM_CHAR[chars[whole + 1]] << 6) | FROM_CHAR[chars[whole + 2]];
      out[o++] = v >> 10;
      out[o++] = (v >> 2) & 255;
    }
    return out;
  },
};

const hasNative =
  typeof (Uint8Array.prototype as Partial<NativeEncode>).toBase64 === "function" &&
  typeof (Uint8Array as unknown as Partial<NativeDecode>).fromBase64 === "function";

/** The engine's own codec, where it has one; null elsewhere. */
export const nativeBase64url: Codec | null = hasNative
  ? {
      encode(bytes) {
        assertBytes(bytes);
        return (bytes as Uint8Array & NativeEncode).toBase64({ alphabet: "base64url", omitPadding: true });
      },
      decode(text) {
        assertCanonical(text);
        return (Uint8Array as unknown as NativeDecode).fromBase64(text, { alphabet: "base64url" });
      },
    }
  : null;

/** Drop-in for @scure/base's base64urlnopad. */
export const base64urlnopad: Codec = nativeBase64url ?? portableBase64url;
