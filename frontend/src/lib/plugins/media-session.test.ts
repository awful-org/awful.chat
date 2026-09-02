import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setNowPlayingFor, type NowPlayingInfo } from "./media-session";

// A minimal navigator.mediaSession double: records what the host applies so
// the arbitration rules (latest claimer wins, only the owner can release)
// are observable.
interface FakeSession {
  metadata: unknown;
  playbackState: string;
  handlers: Map<string, (() => void) | null>;
}

function makeSession(): FakeSession {
  const s: FakeSession = {
    metadata: null,
    playbackState: "none",
    handlers: new Map(),
  };
  (s as unknown as Record<string, unknown>).setActionHandler = (
    action: string,
    fn: (() => void) | null
  ) => s.handlers.set(action, fn);
  return s;
}

class FakeMediaMetadata {
  title: string;
  artist: string;
  artwork: Array<{ src: string }>;
  constructor(init: {
    title: string;
    artist?: string;
    artwork?: Array<{ src: string }>;
  }) {
    this.title = init.title;
    this.artist = init.artist ?? "";
    this.artwork = init.artwork ?? [];
  }
}

let session: FakeSession;

beforeEach(() => {
  session = makeSession();
  vi.stubGlobal("navigator", { mediaSession: session });
  vi.stubGlobal("MediaMetadata", FakeMediaMetadata);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function info(title: string, extra?: Partial<NowPlayingInfo>): NowPlayingInfo {
  return { title, playing: true, ...extra };
}

describe("setNowPlayingFor arbitration", () => {
  it("applies the claimer's metadata and handlers", () => {
    const onPlay = vi.fn();
    setNowPlayingFor(Symbol("a"), info("Song A", { onPlay, playing: false }));
    expect((session.metadata as FakeMediaMetadata).title).toBe("Song A");
    expect(session.playbackState).toBe("paused");
    session.handlers.get("play")?.();
    expect(onPlay).toHaveBeenCalledOnce();
    // No next-track handler was given, so none must be bound.
    expect(session.handlers.get("nexttrack")).toBeNull();
  });

  it("latest claimer wins", () => {
    setNowPlayingFor(Symbol("a"), info("Song A"));
    setNowPlayingFor(Symbol("b"), info("Song B"));
    expect((session.metadata as FakeMediaMetadata).title).toBe("Song B");
  });

  it("a stale claimer's release does not clobber the current owner", () => {
    const a = Symbol("a");
    setNowPlayingFor(a, info("Song A"));
    setNowPlayingFor(Symbol("b"), info("Song B"));
    setNowPlayingFor(a, null);
    expect((session.metadata as FakeMediaMetadata).title).toBe("Song B");
    expect(session.playbackState).toBe("playing");
  });

  it("the owner's release clears the surface", () => {
    const a = Symbol("a");
    setNowPlayingFor(a, info("Song A"));
    setNowPlayingFor(a, null);
    expect(session.metadata).toBeNull();
    expect(session.playbackState).toBe("none");
    expect(session.handlers.get("play")).toBeNull();
  });

  it("releasing when never claimed is a no-op", () => {
    setNowPlayingFor(Symbol("b"), info("Song B"));
    setNowPlayingFor(Symbol("never"), null);
    expect((session.metadata as FakeMediaMetadata).title).toBe("Song B");
  });

  it("survives a missing mediaSession", () => {
    vi.stubGlobal("navigator", {});
    expect(() => setNowPlayingFor(Symbol("a"), info("Song A"))).not.toThrow();
  });
});

// Everything here reaches the OS lock screen, where the page cannot style it,
// bound it or take it back - and a plugin's title and artwork are peer text.
describe("metadata limits", () => {
  const meta = () => session.metadata as FakeMediaMetadata;

  it("caps the title and the artist", () => {
    setNowPlayingFor(
      Symbol("a"),
      info("t".repeat(5000), { artist: "a".repeat(5000) })
    );
    expect(meta().title.length).toBe(200);
    expect(meta().artist.length).toBe(200);
  });

  it("keeps https, blob and data:image artwork", () => {
    for (const url of [
      "https://cdn.example/a.jpg",
      "blob:https://awful.chat/abc",
      "data:image/png;base64,AAAA",
    ]) {
      setNowPlayingFor(Symbol("a"), info("x", { artworkUrl: url }));
      expect(meta().artwork).toEqual([
        { src: url, sizes: "480x360", type: "image/jpeg" },
      ]);
    }
  });

  it("drops artwork the platform would fetch over anything else", () => {
    for (const url of [
      "http://cdn.example/a.jpg",
      "javascript:alert(1)",
      "data:text/html,<script>",
      "file:///etc/passwd",
    ]) {
      setNowPlayingFor(Symbol("a"), info("x", { artworkUrl: url }));
      expect(meta().artwork).toEqual([]);
    }
  });
});
