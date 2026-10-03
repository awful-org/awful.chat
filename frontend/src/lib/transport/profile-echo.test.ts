import { describe, expect, it, vi } from "vitest";
import { ProfileEcho, ProfileFrames, PROFILE_ECHO_WINDOW_MS, frameHash } from "./profile-echo";

const A = new Uint8Array([1, 2, 3]);
const B = new Uint8Array([1, 2, 4]);

describe("profile echo", () => {
  // The bug: three connections to one peer, each sending our profile and
  // answering theirs, put six copies of a 2.09 MB frame on the wire.
  it("sends one copy of the same profile through a connection burst", () => {
    const echo = new ProfileEcho();
    const h = frameHash(A);
    const sent = [0, 40, 120, 900, 1400, 2100].filter((t) =>
      echo.shouldSend("peer1", h, t)
    );
    expect(sent).toEqual([0]);
  });

  it("still sends to a peer that reloads, which takes far longer", () => {
    const echo = new ProfileEcho();
    const h = frameHash(A);
    expect(echo.shouldSend("peer1", h, 0)).toBe(true);
    expect(echo.shouldSend("peer1", h, PROFILE_ECHO_WINDOW_MS + 1)).toBe(true);
  });

  it("sends a changed profile immediately", () => {
    const echo = new ProfileEcho();
    expect(echo.shouldSend("peer1", frameHash(A), 0)).toBe(true);
    expect(echo.shouldSend("peer1", frameHash(B), 10)).toBe(true);
  });

  it("keeps one peer's copy from suppressing another's", () => {
    const echo = new ProfileEcho();
    const h = frameHash(A);
    expect(echo.shouldSend("peer1", h, 0)).toBe(true);
    expect(echo.shouldSend("peer2", h, 10)).toBe(true);
  });

  it("sends identical inherited profiles once to each room and keeps main independent", () => {
    const echo = new ProfileEcho();
    const hash = frameHash(A);
    expect(echo.shouldSend("peer1", hash, 0)).toBe(true);
    expect(echo.shouldSend("peer1", hash, 1, "rd2_a")).toBe(true);
    expect(echo.shouldSend("peer1", hash, 2, "rd2_b")).toBe(true);
    expect(echo.shouldSend("peer1", hash, 3, "rd2_a")).toBe(false);
    expect(echo.shouldSend("peer1", hash, 4, "rd2_b")).toBe(false);
  });

  it("forgets one failed room send or every scope on disconnect", () => {
    const echo = new ProfileEcho();
    const hash = frameHash(A);
    echo.shouldSend("peer1", hash, 0, "rd2_a");
    echo.shouldSend("peer1", hash, 0, "rd2_b");
    echo.forget("peer1", "rd2_a");
    expect(echo.shouldSend("peer1", hash, 1, "rd2_a")).toBe(true);
    expect(echo.shouldSend("peer1", hash, 1, "rd2_b")).toBe(false);
    echo.forget("peer1");
    expect(echo.shouldSend("peer1", hash, 2, "rd2_b")).toBe(true);
  });

  it("re-sends after a disconnect drops the record", () => {
    const echo = new ProfileEcho();
    const h = frameHash(A);
    expect(echo.shouldSend("peer1", h, 0)).toBe(true);
    echo.forget("peer1");
    expect(echo.shouldSend("peer1", h, 10)).toBe(true);
  });

  it("remembers what each peer was delivered, past the burst window, per scope", () => {
    const echo = new ProfileEcho();
    const a = frameHash(A), b = frameHash(B);
    expect(echo.holds("peer1", a)).toBe(false);
    echo.delivered("peer1", a);
    echo.delivered("peer1", b, "rd2_a");
    expect(echo.holds("peer1", a)).toBe(true);
    expect(echo.holds("peer1", b)).toBe(false); // changed: they lack it
    expect(echo.holds("peer1", b, "rd2_a")).toBe(true);
    expect(echo.holds("peer1", a, "rd2_a")).toBe(false);
    expect(echo.holds("peer2", a)).toBe(false);
  });

  it("forgets deliveries with the rest: one scope on a failed send, everything on disconnect", () => {
    const echo = new ProfileEcho();
    const h = frameHash(A);
    echo.delivered("peer1", h);
    echo.delivered("peer1", h, "rd2_a");
    echo.forget("peer1", "rd2_a");
    expect(echo.holds("peer1", h, "rd2_a")).toBe(false);
    expect(echo.holds("peer1", h)).toBe(true);
    echo.forget("peer1");
    expect(echo.holds("peer1", h)).toBe(false);
  });

  it("forgets every peer's records when the session ends", () => {
    const echo = new ProfileEcho();
    const h = frameHash(A);
    echo.shouldSend("peer1", h, 0);
    echo.delivered("peer1", h);
    echo.delivered("peer2", h, "rd2_a");
    echo.clear();
    expect(echo.holds("peer1", h)).toBe(false);
    expect(echo.holds("peer2", h, "rd2_a")).toBe(false);
    expect(echo.shouldSend("peer1", h, 1)).toBe(true);
  });

  it("separates frames that differ only late in a large payload", () => {
    const big = new Uint8Array(200_000);
    const other = new Uint8Array(200_000);
    other[199_999] = 1;
    expect(frameHash(big)).not.toBe(frameHash(other));
  });
});

describe("profile frames", () => {
  // Every read of the profile decrypts fresh buffers, so the bytes are what count.
  const image = (fill: number) => new Uint8Array(64 * 1024).fill(fill).buffer;

  it("builds a frame once for the same fields and image bytes, and again when either changes", () => {
    const frames = new ProfileFrames();
    const build = vi.fn(() => new Uint8Array([build.mock.calls.length]));
    const first = frames.get("", false, "alice", [image(7), undefined], build);
    expect(first.hash).toBe(frameHash(first.frame));
    expect(frames.get("", false, "alice", [image(7), undefined], build)).toBe(first);
    expect(build).toHaveBeenCalledOnce();
    const edited = new Uint8Array(image(7));
    edited[edited.length - 1] = 8;
    expect(frames.get("", false, "alice", [edited.buffer, undefined], build)).not.toBe(first);
    expect(frames.get("", false, "alice", [image(7), image(1)], build)).not.toBe(first);
    expect(frames.get("", false, "alice, renamed", [image(7), image(1)], build)).not.toBe(first);
    expect(build).toHaveBeenCalledTimes(4);
  });

  it("keeps every frame one call asks for, however many rooms have a profile of their own", () => {
    const frames = new ProfileFrames();
    const build = vi.fn(() => new Uint8Array([build.mock.calls.length]));
    const rooms = Array.from({ length: 8 }, (_, i) => `rd2_${i}`);
    // A reply's lookups, in the order _sendProfile makes them: the main frame
    // in both forms, then each room's in both.
    const call = () => {
      frames.get("", true, "main, reply", [image(7)], build);
      frames.get("", false, "main", [image(7)], build);
      for (const room of rooms) {
        frames.get(room, true, `${room}, reply`, [image(7)], build);
        frames.get(room, false, room, [image(7)], build);
      }
    };
    call();
    expect(build).toHaveBeenCalledTimes(18);
    // Four were kept, least recently used first out, so every lookup of the
    // next call found its frame pushed out and built it again.
    call();
    call();
    expect(build).toHaveBeenCalledTimes(18);
  });

  it("replaces the last frame of a kind rather than keeping it beside the new one", () => {
    const frames = new ProfileFrames();
    const build = vi.fn(() => new Uint8Array([build.mock.calls.length]));
    frames.get("", false, "alice", [], build);
    frames.get("", false, "alice, renamed", [], build);
    frames.get("", false, "alice", [], build);
    expect(build).toHaveBeenCalledTimes(3);
  });

  it("drops the frames of rooms left, and every frame when the session ends", () => {
    const frames = new ProfileFrames();
    const build = vi.fn(() => new Uint8Array([build.mock.calls.length]));
    for (const scope of ["", "rd2_a", "rd2_b"]) frames.get(scope, false, scope, [image(1)], build);
    frames.retain(["", "rd2_a"]);
    frames.get("", false, "", [image(1)], build);
    frames.get("rd2_a", false, "rd2_a", [image(1)], build);
    expect(build).toHaveBeenCalledTimes(3);
    frames.get("rd2_b", false, "rd2_b", [image(1)], build);
    expect(build).toHaveBeenCalledTimes(4);
    frames.clear();
    frames.get("", false, "", [image(1)], build);
    expect(build).toHaveBeenCalledTimes(5);
  });

  it("keeps nothing built by a call that began before the session ended", () => {
    const frames = new ProfileFrames();
    const build = vi.fn(() => new Uint8Array([build.mock.calls.length]));
    const began = frames.generation;
    frames.clear();
    frames.get("", false, "alice", [image(2)], build, began);
    frames.get("", false, "alice", [image(2)], build);
    expect(build).toHaveBeenCalledTimes(2);
    frames.get("", false, "alice", [image(2)], build);
    expect(build).toHaveBeenCalledTimes(2);
  });
});
