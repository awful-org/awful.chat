/**
 * Length-prefixed frames (a 4-byte big-endian length, then that many bytes)
 * out of a stream's chunks, copying each byte once.
 *
 * The inbound direct stream used to merge every chunk into one growing buffer
 * - a full copy per chunk - so a 4 MB frame arriving in 16 KB pieces cost
 * about half a gigabyte of copying on the main thread, from anyone able to
 * dial us. This holds the chunks as they came and copies a frame out only
 * when all of it is there.
 */

export class FrameTooLargeError extends Error {
  constructor(readonly bytes: number) {
    super(`frame too large (${bytes} bytes)`);
  }
}

export class FrameAssembler {
  #chunks: Uint8Array[] = [];
  #held = 0;

  constructor(private readonly maxFrameBytes: number) {}

  /**
   * Take one chunk; resolve every frame it completes, in order. Throws
   * FrameTooLargeError as soon as a header announces more than the limit,
   * before anything of that frame is buffered past its first chunk.
   */
  push(chunk: Uint8Array): Uint8Array[] {
    if (chunk.byteLength > 0) {
      this.#chunks.push(chunk);
      this.#held += chunk.byteLength;
    }
    const frames: Uint8Array[] = [];
    while (this.#held >= 4) {
      const length = this.#peekLength();
      if (length > this.maxFrameBytes) throw new FrameTooLargeError(length);
      if (this.#held < 4 + length) break;
      frames.push(this.#take(4 + length).subarray(4));
    }
    return frames;
  }

  /** The big-endian length in the first four held bytes, across chunks. */
  #peekLength(): number {
    const header = new Uint8Array(4);
    let filled = 0;
    for (const chunk of this.#chunks) {
      const n = Math.min(4 - filled, chunk.byteLength);
      header.set(chunk.subarray(0, n), filled);
      filled += n;
      if (filled === 4) break;
    }
    return new DataView(header.buffer).getUint32(0, false);
  }

  /** Remove and return the first `n` held bytes, copying only those. */
  #take(n: number): Uint8Array {
    const out = new Uint8Array(n);
    let offset = 0;
    while (offset < n) {
      const chunk = this.#chunks[0];
      const k = Math.min(n - offset, chunk.byteLength);
      out.set(chunk.subarray(0, k), offset);
      offset += k;
      if (k === chunk.byteLength) this.#chunks.shift();
      else this.#chunks[0] = chunk.subarray(k);
    }
    this.#held -= n;
    return out;
  }
}
