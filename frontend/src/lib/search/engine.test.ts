import { describe, expect, it } from "vitest";
import { MessageType } from "$lib/types/message";
import {
  HAS_FILE,
  HAS_GIF,
  HAS_IMAGE,
  HAS_LINK,
  entryFromMessage,
  matchEntry,
  rankHits,
  snippetFor,
  type SearchableMessage,
} from "./engine";
import { parseSearchQuery } from "./query";

const NOW = 1_756_000_000_000;

function msg(over: Partial<SearchableMessage> = {}): SearchableMessage {
  return {
    id: crypto.randomUUID(),
    roomCode: "room-a",
    lamport: 10,
    timestamp: NOW - 1000,
    senderId: "sender-1",
    senderDid: "did:key:alice",
    senderName: "Alice",
    type: MessageType.Text,
    content: "hello world",
    ...over,
  };
}

describe("entryFromMessage", () => {
  it("indexes text and lowercases once", () => {
    const e = entryFromMessage(msg({ content: "Hello WORLD" }))!;
    expect(e.text).toBe("Hello WORLD");
    expect(e.low).toBe("hello world");
    expect(e.flags).toBe(0);
  });

  it("skips non-searchable types", () => {
    expect(entryFromMessage(msg({ type: MessageType.Reaction }))).toBeNull();
    expect(
      entryFromMessage(msg({ type: MessageType.PluginUpdate }))
    ).toBeNull();
  });

  it("flags files with filenames and mime kinds", () => {
    const e = entryFromMessage(
      msg({
        type: MessageType.File,
        content: "vacation pics",
        meta: {
          files: [
            { filename: "beach.jpg", mimeType: "image/jpeg" },
            { filename: "party.gif", mimeType: "image/gif" },
          ],
        },
      })
    )!;
    expect(e.flags & HAS_FILE).toBeTruthy();
    expect(e.flags & HAS_IMAGE).toBeTruthy();
    expect(e.flags & HAS_GIF).toBeTruthy();
    expect(e.low).toContain("beach.jpg");
    expect(e.low).toContain("vacation");
  });

  it("flags links", () => {
    const e = entryFromMessage(msg({ content: "see https://x.dev/a" }))!;
    expect(e.flags & HAS_LINK).toBeTruthy();
  });

  it("indexes plugin cards under the plugin name", () => {
    const e = entryFromMessage(
      msg({
        type: MessageType.PluginCard,
        content: JSON.stringify({ pluginId: "waffle-party", data: {} }),
      }),
      (id) => (id === "waffle-party" ? "Waffle Party" : undefined)
    )!;
    expect(e.low).toBe("waffle party");
  });

  it("prefers senderDid, falls back to senderId", () => {
    expect(entryFromMessage(msg())!.senderDid).toBe("did:key:alice");
    expect(entryFromMessage(msg({ senderDid: undefined }))!.senderDid).toBe(
      "sender-1"
    );
  });
});

describe("matchEntry", () => {
  const entry = entryFromMessage(
    msg({ content: "Deploy went fine, ship the release" })
  )!;

  it("matches terms at word starts, with highlight ranges", () => {
    const hit = matchEntry(entry, parseSearchQuery("deploy"), NOW)!;
    expect(hit).not.toBeNull();
    expect(hit.ranges[0].start).toBe(0);
    expect(hit.score).toBeGreaterThan(0);
    const prefix = matchEntry(entry, parseSearchQuery("rel"), NOW)!;
    expect(prefix.ranges).toEqual([{ start: 27, end: 30 }]);
  });

  it("does not match letters scattered in order, or mid-word", () => {
    // The fuzzy scorer took both: d..e..p..l in order, "ploy" inside Deploy.
    expect(matchEntry(entry, parseSearchQuery("dpl"), NOW)).toBeNull();
    expect(matchEntry(entry, parseSearchQuery("ploy"), NOW)).toBeNull();
    expect(matchEntry(entry, parseSearchQuery("dwf"), NOW)).toBeNull();
  });

  it("finds a word after punctuation, and prefers a whole-word match", () => {
    const url = entryFromMessage(msg({ content: "see https://github.com/x" }))!;
    expect(matchEntry(url, parseSearchQuery("github"), NOW)).not.toBeNull();
    const whole = matchEntry(
      entryFromMessage(msg({ content: "ship it" }))!, parseSearchQuery("ship"), NOW
    )!;
    const part = matchEntry(
      entryFromMessage(msg({ content: "shipping" }))!, parseSearchQuery("ship"), NOW
    )!;
    expect(whole.score).toBeGreaterThan(part.score);
  });

  it("matches inside text written without spaces", () => {
    const ja = entryFromMessage(msg({ content: "明日のデプロイ" }))!;
    expect(matchEntry(ja, parseSearchQuery("デプロイ"), NOW)).not.toBeNull();
  });

  it("ANDs multiple terms and rejects a missing one", () => {
    expect(
      matchEntry(entry, parseSearchQuery("deploy ship"), NOW)
    ).not.toBeNull();
    expect(matchEntry(entry, parseSearchQuery("deploy zebra"), NOW)).toBeNull();
  });

  it("quoted phrases must match contiguously", () => {
    expect(
      matchEntry(entry, parseSearchQuery('"went fine"'), NOW)
    ).not.toBeNull();
    expect(matchEntry(entry, parseSearchQuery('"fine went"'), NOW)).toBeNull();
  });

  it("from: matches sender name fuzzily and DID by prefix", () => {
    expect(matchEntry(entry, parseSearchQuery("from:ali"), NOW)).not.toBeNull();
    expect(
      matchEntry(entry, parseSearchQuery("from:did:key:al"), NOW)
    ).not.toBeNull();
    expect(matchEntry(entry, parseSearchQuery("from:bob"), NOW)).toBeNull();
  });

  it("has: requires the flag", () => {
    expect(matchEntry(entry, parseSearchQuery("has:image"), NOW)).toBeNull();
  });

  it("filter-only queries match on recency alone", () => {
    const img = entryFromMessage(
      msg({
        type: MessageType.File,
        content: "",
        meta: { files: [{ filename: "a.png", mimeType: "image/png" }] },
      })
    )!;
    const hit = matchEntry(img, parseSearchQuery("has:image"), NOW)!;
    expect(hit).not.toBeNull();
    expect(hit.ranges).toEqual([]);
  });

  it("before/after bound by timestamp", () => {
    const day = 24 * 60 * 60 * 1000;
    const old = { ...entry, timestamp: NOW - 40 * day };
    expect(matchEntry(old, parseSearchQuery("after:today", NOW), NOW)).toBeNull();
    expect(
      matchEntry(old, { ...parseSearchQuery("deploy"), before: NOW - 30 * day },
        NOW)
    ).not.toBeNull();
  });

  it("recency decays the score", () => {
    const day = 24 * 60 * 60 * 1000;
    const fresh = matchEntry(entry, parseSearchQuery("deploy"), NOW)!;
    const stale = matchEntry(
      { ...entry, timestamp: NOW - 60 * day },
      parseSearchQuery("deploy"),
      NOW
    )!;
    expect(fresh.score).toBeGreaterThan(stale.score);
    // A month of age must not zero a match out entirely.
    expect(stale.score).toBeGreaterThan(0);
  });
});

describe("rankHits", () => {
  it("sorts best-first, lamport breaks ties, truncates", () => {
    const a = matchEntry(
      entryFromMessage(msg({ content: "deploy", lamport: 1 }))!,
      parseSearchQuery("deploy"),
      NOW
    )!;
    const b = matchEntry(
      entryFromMessage(msg({ content: "deploy", lamport: 2 }))!,
      parseSearchQuery("deploy"),
      NOW
    )!;
    const ranked = rankHits([a, b], 10);
    expect(ranked[0].entry.lamport).toBe(2);
    expect(rankHits([a, b], 1)).toHaveLength(1);
  });
});

describe("snippetFor", () => {
  it("returns short text whole", () => {
    const e = entryFromMessage(msg({ content: "short one" }))!;
    const s = snippetFor(e, [{ start: 0, end: 5 }]);
    expect(s.text).toBe("short one");
    expect(s.leading).toBe(false);
  });

  it("windows long text around the first match and rebases ranges", () => {
    const pad = "x".repeat(300);
    const e = entryFromMessage(msg({ content: `${pad} needle after` }))!;
    const at = e.low.indexOf("needle");
    const s = snippetFor(e, [{ start: at, end: at + 6 }]);
    expect(s.text).toContain("needle");
    expect(s.leading).toBe(true);
    const r = s.ranges[0];
    expect(s.text.slice(r.start, r.end)).toBe("needle");
  });
});
