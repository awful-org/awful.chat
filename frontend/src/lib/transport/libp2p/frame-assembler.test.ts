import { describe, expect, it } from "vitest";
import { FrameAssembler, FrameTooLargeError } from "./frame-assembler";

function frame(payload: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + payload.length);
  new DataView(out.buffer).setUint32(0, payload.length, false);
  out.set(payload, 4);
  return out;
}
const bytes = (...values: number[]) => new Uint8Array(values);

describe("FrameAssembler", () => {
  it("yields whole frames only, across any chunking", () => {
    const stream = new Uint8Array([...frame(bytes(1, 2, 3)), ...frame(bytes()), ...frame(bytes(9))]);
    for (const size of [1, 2, 3, 5, 7, stream.length]) {
      const assembler = new FrameAssembler(1024);
      const out: number[][] = [];
      for (let i = 0; i < stream.length; i += size) {
        for (const f of assembler.push(stream.subarray(i, i + size))) out.push([...f]);
      }
      expect(out).toEqual([[1, 2, 3], [], [9]]);
    }
  });

  it("refuses a header over the limit before buffering the frame", () => {
    const assembler = new FrameAssembler(8);
    expect(() => assembler.push(frame(new Uint8Array(9)).subarray(0, 4))).toThrow(FrameTooLargeError);
  });

  it("assembles a 4 MB frame from 16 KB pieces in linear time", () => {
    const payload = new Uint8Array(4 * 1024 * 1024).map((_, i) => i & 0xff);
    const whole = frame(payload);
    const assembler = new FrameAssembler(4 * 1024 * 1024);
    const started = performance.now();
    let got: Uint8Array | undefined;
    for (let i = 0; i < whole.length; i += 16 * 1024) {
      got = assembler.push(whole.subarray(i, i + 16 * 1024))[0] ?? got;
    }
    expect(got?.length).toBe(payload.length);
    expect(got?.[123_456]).toBe(123_456 & 0xff);
    // The quadratic merge took seconds here; this takes milliseconds.
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("FrameAssembler one frame at a time", () => {
  it("reads the limit after each frame, so an earlier frame can raise it", () => {
    let limit = 4;
    const assembler = new FrameAssembler(() => limit);
    const small = new Uint8Array([0, 0, 0, 2, 1, 2]);
    const big = new Uint8Array([0, 0, 0, 6, 1, 2, 3, 4, 5, 6]);
    const both = new Uint8Array(small.length + big.length);
    both.set(small);
    both.set(big, small.length);
    assembler.add(both);
    expect(Array.from(assembler.next()!)).toEqual([1, 2]);
    limit = 16;
    expect(Array.from(assembler.next()!)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(assembler.next()).toBeNull();
  });

  it("refuses a header over the limit before the frame arrives", () => {
    const assembler = new FrameAssembler(() => 8);
    assembler.add(new Uint8Array([0, 0, 1, 0, 9]));
    expect(() => assembler.next()).toThrow(FrameTooLargeError);
  });
});
