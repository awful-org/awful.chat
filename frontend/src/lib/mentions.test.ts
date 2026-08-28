import { describe, expect, it } from "vitest";
import {
  buildMentionCandidates,
  humanize,
  mentionsMe,
  segmentDraft,
  serialize,
} from "./mentions";

describe("mentions", () => {
  describe("serialize", () => {
    it("replaces @Name with @[did] tokens", () => {
      const nameToDidMap = new Map([["Alice", "did:key:z6MkAlice"]]);
      const input = "Hey @Alice, how are you?";
      const result = serialize(input, nameToDidMap);
      expect(result).toBe("Hey @[did:key:z6MkAlice], how are you?");
    });

    it("handles multiple mentions", () => {
      const nameToDidMap = new Map([
        ["Alice", "did:key:z6MkAlice"],
        ["Bob", "did:key:z6MkBob"],
      ]);
      const input = "@Alice and @Bob, let's chat";
      const result = serialize(input, nameToDidMap);
      expect(result).toBe("@[did:key:z6MkAlice] and @[did:key:z6MkBob], let's chat");
    });

    it("processes names in longest-first order to avoid prefix collisions", () => {
      const nameToDidMap = new Map([
        ["Ana", "did:key:z6MkAna"],
        ["Anna", "did:key:z6MkAnna"],
      ]);
      const input = "@Anna and @Ana are here";
      const result = serialize(input, nameToDidMap);
      expect(result).toBe("@[did:key:z6MkAnna] and @[did:key:z6MkAna] are here");
    });

    it("does not replace unrecorded @mentions", () => {
      const nameToDidMap = new Map([["Alice", "did:key:z6MkAlice"]]);
      const input = "@Alice and @Charlie";
      const result = serialize(input, nameToDidMap);
      expect(result).toBe("@[did:key:z6MkAlice] and @Charlie");
    });

    it("ignores partial word matches", () => {
      const nameToDidMap = new Map([["Alice", "did:key:z6MkAlice"]]);
      const input = "@Alice @Alice-admin @Alice-bot";
      const result = serialize(input, nameToDidMap);
      // Only @Alice without suffix should be replaced
      expect(result).toBe("@[did:key:z6MkAlice] @Alice-admin @Alice-bot");
    });

    it("handles empty name-to-did map", () => {
      const input = "@Alice and @Bob";
      const result = serialize(input, new Map());
      expect(result).toBe("@Alice and @Bob");
    });

    it("round-trips: serialize then humanize", () => {
      const nameToDidMap = new Map([["Alice", "did:key:z6MkAlice"]]);
      const input = "Hey @Alice!";

      const serialized = serialize(input, nameToDidMap);
      expect(serialized).toBe("Hey @[did:key:z6MkAlice]!");

      const resolveName = (did: string) => {
        if (did === "did:key:z6MkAlice") return "Alice";
        return did.slice(0, 8);
      };

      const humanized = humanize(serialized, resolveName);
      expect(humanized).toContain("@Alice");
      expect(humanized).toContain("span");
      expect(humanized).toContain("primary");
    });
  });

  describe("humanize", () => {
    it("converts @[did] tokens to styled mention chips", () => {
      const resolveName = (did: string) => {
        if (did === "did:key:z6MkAlice") return "Alice";
        return did.slice(0, 8);
      };
      const input = "@[did:key:z6MkAlice] says hi";
      const result = humanize(input, resolveName);
      expect(result).toContain("@Alice");
      expect(result).toContain("span");
      expect(result).toContain("primary");
    });

    it("resolves unknown dids with a short prefix", () => {
      const resolveName = (did: string) => did.slice(0, 8);
      const input = "@[did:key:z6MkUnknown]";
      const result = humanize(input, resolveName);
      expect(result).toContain("@did:key:");
    });

    it("handles multiple mentions", () => {
      const resolveName = (did: string) => {
        if (did === "did:key:z6MkAlice") return "Alice";
        if (did === "did:key:z6MkBob") return "Bob";
        return did.slice(0, 8);
      };
      const input = "@[did:key:z6MkAlice] and @[did:key:z6MkBob]";
      const result = humanize(input, resolveName);
      expect(result).toContain("@Alice");
      expect(result).toContain("@Bob");
    });

    it("does not mangle content without mentions", () => {
      const resolveName = (did: string) => did.slice(0, 8);
      const input = "Just regular text with @-signs at words";
      const result = humanize(input, resolveName);
      // Should not contain mention chip markup for these
      expect(result).toContain("@-signs");
    });

    it("does not process inside code fences (does not implement code fence handling)", () => {
      // Note: Code fence exclusion is the responsibility of the caller
      // humanize is text-only and does not parse markdown/code blocks.
      // Integration happens in MsgRender where code/link processing already runs.
      const resolveName = (did: string) => "Alice";
      const input = "`@[did:key:z6MkAlice]` in code";
      const result = humanize(input, resolveName);
      // humanize will still replace it - code handling is in MsgRender
      expect(result).toContain("@Alice");
    });
  });

  describe("mentionsMe", () => {
    it("detects when content mentions my DID", () => {
      const selfDids = ["did:key:z6MkMe"];
      const content = "@[did:key:z6MkMe] you got a message";
      expect(mentionsMe(content, selfDids)).toBe(true);
    });

    it("returns false when content does not mention me", () => {
      const selfDids = ["did:key:z6MkMe"];
      const content = "@[did:key:z6MkOther] you got a message";
      expect(mentionsMe(content, selfDids)).toBe(false);
    });

    it("handles multiple self DIDs (identity did + transport selfId)", () => {
      const selfDids = ["did:key:z6MkIdentity", "12D3Ko...PeerId"];
      const content = "@[12D3Ko...PeerId] check this";
      expect(mentionsMe(content, selfDids)).toBe(true);
    });

    it("returns false for plain text @mentions", () => {
      const selfDids = ["did:key:z6MkMe"];
      const content = "@Alice says hi";
      expect(mentionsMe(content, selfDids)).toBe(false);
    });

    it("returns false for no mentions at all", () => {
      const selfDids = ["did:key:z6MkMe"];
      const content = "Just some text with no mentions";
      expect(mentionsMe(content, selfDids)).toBe(false);
    });

    it("handles multiple mentions and finds me among others", () => {
      const selfDids = ["did:key:z6MkMe"];
      const content = "@[did:key:z6MkAlice] @[did:key:z6MkMe] @[did:key:z6MkBob]";
      expect(mentionsMe(content, selfDids)).toBe(true);
    });
  });
});

describe("humanize escaping", () => {
  it("escapes peer-controlled names before they reach @html", () => {
    const out = humanize("@[did:key:zEvil]", () => "<img src=x onerror=alert(1)>");
    expect(out).not.toContain("<img");
    expect(out).toContain("&lt;img");
  });
});

describe("segmentDraft", () => {
  const alice = new Map([["Alice", "did:key:z6MkAlice"]]);

  it("returns nothing for an empty draft", () => {
    expect(segmentDraft("", alice)).toEqual([]);
  });

  it("returns one plain run when no name is recorded", () => {
    expect(segmentDraft("@Alice hi", new Map())).toEqual([
      { text: "@Alice hi", did: null },
    ]);
  });

  it("tags a recorded mention and leaves the rest plain", () => {
    expect(segmentDraft("Hey @Alice!", alice)).toEqual([
      { text: "Hey ", did: null },
      { text: "@Alice", did: "did:key:z6MkAlice" },
      { text: "!", did: null },
    ]);
  });

  it("leaves an unrecorded @name plain", () => {
    const segments = segmentDraft("@Alice and @Charlie", alice);
    expect(segments).toEqual([
      { text: "@Alice", did: "did:key:z6MkAlice" },
      { text: " and @Charlie", did: null },
    ]);
  });

  it("does not tag a name that is only a prefix of the typed word", () => {
    const segments = segmentDraft("@Alice-bot pinged", alice);
    expect(segments).toEqual([{ text: "@Alice-bot pinged", did: null }]);
  });

  it("prefers the longest recorded name on a collision", () => {
    const map = new Map([
      ["Ana", "did:key:z6MkAna"],
      ["Anna", "did:key:z6MkAnna"],
    ]);
    expect(segmentDraft("@Anna and @Ana", map)).toEqual([
      { text: "@Anna", did: "did:key:z6MkAnna" },
      { text: " and ", did: null },
      { text: "@Ana", did: "did:key:z6MkAna" },
    ]);
  });

  it("handles names containing spaces and regex metacharacters", () => {
    const map = new Map([["A. (dev)", "did:key:z6MkDev"]]);
    expect(segmentDraft("ping @A. (dev) now", map)).toEqual([
      { text: "ping ", did: null },
      { text: "@A. (dev)", did: "did:key:z6MkDev" },
      { text: " now", did: null },
    ]);
  });

  it("concatenating the segments reproduces the draft exactly", () => {
    const map = new Map([
      ["Alice", "did:key:z6MkAlice"],
      ["Bob", "did:key:z6MkBob"],
    ]);
    const draft = "@Alice, ping @Bob about @Charlie\nthanks";
    const joined = segmentDraft(draft, map)
      .map((s) => s.text)
      .join("");
    expect(joined).toBe(draft);
  });

  it("agrees with serialize about what is a mention", () => {
    const map = new Map([
      ["Alice", "did:key:z6MkAlice"],
      ["Bob", "did:key:z6MkBob"],
    ]);
    const draft = "@Alice @Alice-bot @Bob @Charlie";
    const highlighted = segmentDraft(draft, map)
      .filter((s) => s.did !== null)
      .map((s) => s.text);
    expect(highlighted).toEqual(["@Alice", "@Bob"]);
    expect(serialize(draft, map)).toBe(
      "@[did:key:z6MkAlice] @Alice-bot @[did:key:z6MkBob] @Charlie"
    );
  });
});

describe("buildMentionCandidates", () => {
  /** A roster where names are known for everyone unless stated otherwise. */
  const names: Record<string, string> = {
    "did:alice": "Alice",
    "did:bob": "Bob",
    "did:carol": "Carol",
    "did:me": "Me",
  };
  const peerToDid: Record<string, string> = {
    "peer-alice": "did:alice",
    "peer-me": "did:me",
  };

  function build(over: Partial<Parameters<typeof buildMentionCandidates>[0]> = {}) {
    return buildMentionCandidates({
      roomUsers: ["did:alice", "did:bob", "did:carol"],
      peers: [],
      toDid: (id) => peerToDid[id] ?? id,
      nameOf: (id) => names[id],
      selfIds: ["did:me", "peer-me"],
      ...over,
    });
  }

  it("offers a roster member who is not connected", () => {
    // The whole point: nobody is online here, and all three are still offerable.
    expect(build().map((c) => c.name)).toEqual(["Alice", "Bob", "Carol"]);
  });

  it("marks a connected member online and an absent one offline", () => {
    const out = build({ peers: ["peer-alice"] });
    expect(out.find((c) => c.name === "Alice")?.online).toBe(true);
    expect(out.find((c) => c.name === "Bob")?.online).toBe(false);
  });

  it("puts online members before offline ones", () => {
    // Carol sorts last alphabetically but first when she is the one connected.
    const out = build({
      peers: ["peer-carol"],
      toDid: (id) => (id === "peer-carol" ? "did:carol" : (peerToDid[id] ?? id)),
    });
    expect(out[0].name).toBe("Carol");
  });

  it("sorts alphabetically within the same online state", () => {
    expect(build({ roomUsers: ["did:carol", "did:bob", "did:alice"] }).map((c) => c.name)).toEqual(
      ["Alice", "Bob", "Carol"]
    );
  });

  it("never offers you yourself, by DID or by peer id", () => {
    const out = build({ roomUsers: ["did:alice", "did:me"], peers: ["peer-me"] });
    expect(out.map((c) => c.name)).toEqual(["Alice"]);
  });

  it("drops a member whose name is not known", () => {
    // The caller's fallback would be a DID fragment, and `@did:key:z6Mk` is not
    // a mention anybody means to type.
    const out = build({ roomUsers: ["did:alice", "did:stranger"] });
    expect(out.map((c) => c.did)).toEqual(["did:alice"]);
  });

  it("reports one entry per person when the roster and the peers overlap", () => {
    const out = build({ roomUsers: ["did:alice"], peers: ["peer-alice"] });
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ did: "did:alice", name: "Alice", online: true });
  });

  it("resolves a name keyed by peer id when the DID has none", () => {
    const out = build({
      roomUsers: [],
      peers: ["peer-zed"],
      toDid: (id) => (id === "peer-zed" ? "did:zed" : id),
      nameOf: (id) => (id === "peer-zed" ? "Zed" : names[id]),
    });
    expect(out).toEqual([{ did: "did:zed", name: "Zed", online: true }]);
  });

  it("ignores empty ids", () => {
    expect(build({ roomUsers: ["", "did:alice"] }).map((c) => c.name)).toEqual(["Alice"]);
  });

  it("returns nothing for an empty roster", () => {
    expect(build({ roomUsers: [], peers: [] })).toEqual([]);
  });
});
