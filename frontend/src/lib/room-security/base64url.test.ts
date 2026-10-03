import { describe, expect, it } from "vitest";
import { base64urlnopad as scure } from "@scure/base";
import { base64urlnopad, nativeBase64url, portableBase64url } from "./base64url";

const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
// What a hostile or broken peer might put in a field instead: padding, the
// other alphabet, whitespace, controls and non-ASCII.
const JUNK = ["=", "+", "/", " ", "\n", "\t", "\u0000", "é", "\u{1F600}", "."];

/** A small, seeded generator, so a failure names an input that comes back. */
function random(seed: number) {
  let state = seed >>> 0;
  return (below: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state % below;
  };
}

function bytesOf(length: number, next: (below: number) => number): Uint8Array {
  const bytes = new Uint8Array(length);
  for (let i = 0; i < length; i++) bytes[i] = next(256);
  return bytes;
}

function outcome(decode: (text: string) => Uint8Array, text: string): Uint8Array | "throws" {
  try {
    return decode(text);
  } catch {
    return "throws";
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((byte, i) => byte === b[i]);
}

const codecs = [
  ["portable", portableBase64url],
  ["native", nativeBase64url],
] as const;

describe.each(codecs)("%s base64url", (_name, codec) => {
  // The engine's own codec is optional: Node 22 and 24 have none, Node 25 and
  // current browsers do. Whichever one this engine has is the one shipped.
  it.runIf(codec !== null)("encodes every length exactly as @scure/base does, and decodes it back", () => {
    const next = random(1);
    for (let length = 0; length <= 600; length++) {
      const bytes = bytesOf(length, next);
      const text = codec!.encode(bytes);
      expect(text).toBe(scure.encode(bytes));
      expect(sameBytes(codec!.decode(text), bytes)).toBe(true);
    }
    // Room-frame sizes: a full 256 KiB fragment, its ciphertext, a 1 MiB
    // profile, and lengths either side of a 3-byte group.
    for (const length of [262_144, 262_160, 1_048_576 + 1, 1_048_576 + 2]) {
      const bytes = bytesOf(length, next);
      const text = codec!.encode(bytes);
      expect(text === scure.encode(bytes)).toBe(true);
      expect(sameBytes(codec!.decode(text), bytes)).toBe(true);
    }
  });

  it.runIf(codec !== null)("encodes a view into a larger buffer as only its own bytes", () => {
    const whole = bytesOf(1000, random(2));
    const view = whole.subarray(123, 789);
    expect(codec!.encode(view)).toBe(scure.encode(view));
  });

  it.runIf(codec !== null)("accepts and refuses exactly the strings @scure/base does", () => {
    const next = random(3);
    const cases: string[] = ["", "A", "AA", "AB", "AQ", "AAA", "AAB", "AAE", "AAAA", "AA==", "AAA=", "=", "====",
      " AAA", "AAA ", "AA\nAA", "+/+/", "-_-_", "AAAAA", "AAAAAA", "AAAAAAA"];
    // Every possible last character after one and after two full bytes: the
    // spare bits are what a lenient decoder lets through.
    for (const last of ALPHABET) cases.push(`A${last}`, `AA${last}`, `AAAAA${last}`, `AAAAAA${last}`);
    for (let n = 0; n < 4000; n++) {
      let text = "";
      const length = next(14);
      for (let i = 0; i < length; i++) {
        text += next(12) === 0 ? JUNK[next(JUNK.length)] : ALPHABET[next(ALPHABET.length)];
      }
      cases.push(text);
    }
    let refused = 0;
    for (const text of cases) {
      const expected = outcome(scure.decode, text);
      const actual = outcome(codec!.decode, text);
      if (expected === "throws") {
        refused++;
        expect(actual, JSON.stringify(text)).toBe("throws");
      } else {
        expect(actual, JSON.stringify(text)).not.toBe("throws");
        expect(sameBytes(actual as Uint8Array, expected), JSON.stringify(text)).toBe(true);
      }
    }
    // The cases must exercise both sides, or this proves nothing.
    expect(refused).toBeGreaterThan(500);
    expect(cases.length - refused).toBeGreaterThan(500);
  });

  it.runIf(codec !== null)("refuses what is not a string or not bytes", () => {
    expect(() => codec!.decode(42 as unknown as string)).toThrow();
    expect(() => codec!.decode(null as unknown as string)).toThrow();
    expect(() => codec!.encode([1, 2, 3] as unknown as Uint8Array)).toThrow();
    expect(() => codec!.encode("AAAA" as unknown as Uint8Array)).toThrow();
  });
});

it("ships the engine's own codec where there is one", () => {
  expect(base64urlnopad).toBe(nativeBase64url ?? portableBase64url);
});
