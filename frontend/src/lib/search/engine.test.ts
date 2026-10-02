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
  scoreEntry,
  searchEntries,
  snippetFor,
  type SearchEntry,
  type SearchHit,
  type SearchableMessage,
} from "./engine";
import { parseSearchQuery } from "./query";
import { matchExact } from "$lib/palette/scorer";

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

  it("indexes what the message reads as, markdown dropped", () => {
    const e = entryFromMessage(msg({ content: "**Launch** is on *Friday*, see [the plan](https://a.bc)" }))!;
    expect(e.text).toBe("Launch is on Friday, see the plan https://a.bc");
    const hit = matchEntry(e, parseSearchQuery("launch friday"), NOW)!;
    expect(hit.ranges).toEqual([{ start: 0, end: 6 }, { start: 13, end: 19 }]);
    // The label is what shows; the target is still found by its domain.
    expect(matchEntry(e, parseSearchQuery("a.bc"), NOW)).not.toBeNull();
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

describe("searchEntries", () => {
  // A seeded generator, so a failure names the corpus that broke it.
  function corpus(seed: number, size: number): SearchEntry[] {
    let state = seed;
    const next = () => {
      state = (state * 1103515245 + 12345) % 2147483648;
      return state / 2147483648;
    };
    const words = ["deploy", "the", "relay", "thing", "then", "hello", "dep", "ship"];
    const names = ["Alice", "Bob", "Carol"];
    const out: SearchEntry[] = [];
    for (let i = 0; i < size; i++) {
      const count = 1 + Math.floor(next() * 5);
      const text = Array.from(
        { length: count },
        () => words[Math.floor(next() * words.length)]
      ).join(" ");
      const name = names[Math.floor(next() * names.length)];
      out.push(
        entryFromMessage(
          msg({
            content: text,
            // Few distinct lamports and days, so exact ties are common.
            lamport: Math.floor(next() * 20),
            timestamp: NOW - Math.floor(next() * 4) * 24 * 60 * 60 * 1000,
            senderName: name,
            senderDid: `did:key:${name.toLowerCase()}`,
          })
        )!
      );
    }
    return out;
  }

  function fullRanking(lists: SearchEntry[][], query: string, limit: number): SearchHit[] {
    const hits: SearchHit[] = [];
    for (const list of lists) {
      for (const entry of list) {
        const hit = matchEntry(entry, parseSearchQuery(query), NOW);
        if (hit) hits.push(hit);
      }
    }
    return rankHits(hits, limit);
  }

  it("keeps the best hits in the order a full ranking gives, ties included", () => {
    for (const seed of [1, 7, 42]) {
      const lists = [corpus(seed, 400), corpus(seed + 1, 300)];
      for (const query of ["t", "the", "dep", "deploy then", '"lo"', "from:bo", "from:did:key:c th"]) {
        for (const limit of [1, 5, 80, 2000]) {
          const got = searchEntries(lists, parseSearchQuery(query), limit, NOW);
          const want = fullRanking(lists, query, limit);
          expect(got.map((h) => h.entry.id), `${seed} ${query} ${limit}`).toEqual(
            want.map((h) => h.entry.id)
          );
          expect(got.map((h) => h.score)).toEqual(want.map((h) => h.score));
          expect(got.map((h) => h.ranges)).toEqual(want.map((h) => h.ranges));
        }
      }
    }
  });

  it("returns nothing for a limit of zero, or when nothing matches", () => {
    const lists = [corpus(3, 50)];
    expect(searchEntries(lists, parseSearchQuery("the"), 0, NOW)).toEqual([]);
    expect(searchEntries(lists, parseSearchQuery("zebra"), 80, NOW)).toEqual([]);
  });

  it("scores exactly what matchEntry scores, and rejects what it rejects", () => {
    const entries = corpus(11, 200);
    for (const query of ["de", "relay", '"y th"', "has:link", "from:alice ship"]) {
      const q = parseSearchQuery(query);
      for (const entry of entries) {
        const hit = matchEntry(entry, q, NOW);
        const score = scoreEntry(entry, q, NOW);
        if (hit) expect(score).toBe(hit.score);
        else expect(score).toBeLessThan(0);
      }
    }
  });

  // The ranking pass scores without the palette's matchExact so it builds no
  // positions arrays; the numbers must stay the ones matchExact gave.
  it("scores terms the way matchExact did", () => {
    const WORD = /[\p{L}\p{N}_]/u;
    const UNSPACED = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Thai}]/u;
    function previousScore(low: string, term: { text: string; exact: boolean }): number | null {
      if (term.exact || UNSPACED.test(term.text[0])) {
        return matchExact(low, term.text)?.score ?? null;
      }
      for (let at = low.indexOf(term.text); at >= 0; at = low.indexOf(term.text, at + 1)) {
        if (at > 0 && WORD.test(low[at - 1])) continue;
        const end = at + term.text.length;
        const whole = end === low.length || !WORD.test(low[end]);
        return matchExact(low.slice(at), term.text)!.score + (whole ? term.text.length * 8 : 0);
      }
      return null;
    }
    const texts = ["deploy went fine", "redeploy", "the deployment", "deploy", "明日のデプロイ", "x deploy_y"];
    for (const text of texts) {
      const entry = entryFromMessage(msg({ content: text, timestamp: NOW }))!;
      for (const query of ["deploy", "dep", '"ploy"', "デプロイ", "went fine"]) {
        const q = parseSearchQuery(query);
        let expected: number | null = 0;
        for (const term of q.terms) {
          const s = previousScore(entry.low, term);
          expected = s === null || expected === null ? null : expected + s;
        }
        const score = scoreEntry(entry, q, NOW);
        if (expected === null) expect(score, `${text} / ${query}`).toBeLessThan(0);
        else expect(score, `${text} / ${query}`).toBe(1 + expected);
      }
    }
  });

  it("ranks a hit whose timestamp is not a number, rather than scoring it NaN", () => {
    const odd = {
      ...entryFromMessage(msg({ content: "deploy" }))!,
      timestamp: "soon" as unknown as number,
    };
    const fine = entryFromMessage(msg({ content: "deploy", lamport: 99 }))!;
    const score = scoreEntry(odd, parseSearchQuery("deploy"), NOW);
    expect(Number.isFinite(score)).toBe(true);
    const ranked = searchEntries([[odd, fine]], parseSearchQuery("deploy"), 1, NOW);
    expect(ranked).toHaveLength(1);
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
