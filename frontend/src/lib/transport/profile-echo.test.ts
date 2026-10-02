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
    const first = frames.get("alice", [image(7), undefined], build);
    expect(first.hash).toBe(frameHash(first.frame));
    expect(frames.get("alice", [image(7), undefined], build)).toBe(first);
    expect(build).toHaveBeenCalledOnce();
    const edited = new Uint8Array(image(7));
    edited[edited.length - 1] = 8;
    expect(frames.get("alice", [edited.buffer, undefined], build)).not.toBe(first);
    expect(frames.get("alice", [image(7), image(1)], build)).not.toBe(first);
    expect(frames.get("alice, renamed", [image(7), image(1)], build)).not.toBe(first);
    expect(build).toHaveBeenCalledTimes(4);
  });

  it("keeps only so many, the least recently asked for going first", () => {
    const frames = new ProfileFrames(2);
    const build = vi.fn(() => new Uint8Array([1]));
    frames.get("main", [], build);
    frames.get("room a", [], build);
    frames.get("main", [], build);
    frames.get("room b", [], build);
    expect(build).toHaveBeenCalledTimes(3);
    frames.get("main", [], build);
    expect(build).toHaveBeenCalledTimes(3);
    frames.get("room a", [], build);
    expect(build).toHaveBeenCalledTimes(4);
  });
});
