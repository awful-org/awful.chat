import { describe, expect, it } from "vitest";
import {
  MAX_ARGS,
  MAX_GAME,
  PRESENCE_TTL_MS,
  initialState,
  parseAppCommand,
  parseAppUrl,
  playerId,
  presentPlayers,
  reduce,
  type AppState,
} from "./logic";
import { MAX_MESSAGE_BYTES, helloMessage, rateLimiter, readAppMessage } from "./bridge";

const ANA = "did:key:zAna";
const BO = "did:key:zBo";
const card = { url: "https://je.frav.in/game", sessionId: "s_abcdefghijkl", salt: "saltsaltsaltsalt", args: "ROOM42" };
const ctx = (did: string, ephemeral: boolean, name = "Ana") => ({
  senderDid: did,
  senderName: name,
  updateId: "u1",
  lamport: ephemeral ? 0 : 5,
  ephemeral,
});

describe("/app {url} {args}", () => {
  it("takes https addresses, and a bare host as https", () => {
    expect(parseAppUrl("https://je.frav.in/x?y=1")?.href).toBe("https://je.frav.in/x?y=1");
    expect(parseAppUrl("je.frav.in")?.href).toBe("https://je.frav.in/");
  });

  it("refuses anything that is not a plain https page", () => {
    for (const bad of ["http://je.frav.in", "javascript:alert(1)", "data:text/html,hi", "https://user:pw@je.frav.in", "localhost", "", "ftp://a.bc"]) {
      expect(parseAppUrl(bad), bad).toBeNull();
    }
  });

  it("passes what follows the URL to the app, bounded", () => {
    expect(parseAppCommand("je.frav.in ROOM42")).toMatchObject({ args: "ROOM42" });
    expect(parseAppCommand("  https://a.bc   two words  ")).toMatchObject({ args: "two words" });
    expect(parseAppCommand("https://a.bc")).toMatchObject({ args: "" });
    expect(parseAppCommand(`https://a.bc ${"x".repeat(MAX_ARGS + 1)}`)).toBeNull();
    expect(parseAppCommand("not a url")).toBeNull();
  });
});

describe("the card", () => {
  it("keeps what it needs and names the starter from the host, not the payload", () => {
    const s = initialState({ ...card, starter: BO }, { senderDid: ANA });
    expect(s).toMatchObject({ url: card.url, origin: "https://je.frav.in", args: "ROOM42", starter: ANA, ended: false });
  });

  it("is unusable, and takes no tile, without a valid url, session or salt", () => {
    for (const bad of [{ ...card, url: "http://x.y" }, { ...card, sessionId: "" }, { ...card, salt: "!" }, null]) {
      const s = initialState(bad, { senderDid: ANA });
      expect(s.ended).toBe(true);
      expect(s.url).toBe("");
    }
  });
});

describe("reduce", () => {
  const start = (): AppState => initialState(card, { senderDid: ANA });

  it("ends only for the starter, and only through a stored update", () => {
    expect(reduce(start(), { data: { t: "end" } }, ctx(BO, false)).ended).toBe(false);
    expect(reduce(start(), { data: { t: "end" } }, ctx(ANA, true)).ended).toBe(false);
    expect(reduce(start(), { data: { t: "end" } }, ctx(ANA, false)).ended).toBe(true);
  });

  it("tracks who has it open from live updates only", () => {
    let s = reduce(start(), { data: { t: "join" } }, ctx(BO, true, "Bo"));
    expect(presentPlayers(s).map((p) => p.name)).toEqual(["Bo"]);
    expect(reduce(s, { data: { t: "join" } }, ctx(ANA, false))).toBe(s);
    s = reduce(s, { data: { t: "leave" } }, ctx(BO, true));
    expect(presentPlayers(s)).toEqual([]);
  });

  it("keeps the game a player's app advertised, as one clean line", () => {
    let s = reduce(start(), { data: { t: "join", g: "Jeopardy\n\u202Eround 2" } }, ctx(BO, true, "Bo"));
    expect(presentPlayers(s)[0].game).toBe("Jeopardy round 2");
    s = reduce(s, { data: { t: "here", g: "x".repeat(MAX_GAME + 10) } }, ctx(BO, true, "Bo"));
    expect(presentPlayers(s)[0].game).toHaveLength(MAX_GAME);
    s = reduce(s, { data: { t: "here" } }, ctx(BO, true, "Bo"));
    expect(presentPlayers(s)[0].game).toBeUndefined();
    s = reduce(s, { data: { t: "here", g: { evil: true } } }, ctx(BO, true, "Bo"));
    expect(presentPlayers(s)[0].game).toBeUndefined();
  });

  it("forgets someone not heard from in a while", () => {
    const s = reduce(start(), { data: { t: "here" } }, ctx(BO, true, "Bo"));
    expect(presentPlayers(s, Date.now() + PRESENCE_TTL_MS + 1)).toEqual([]);
  });

  it("ignores presence once ended, and junk always", () => {
    const ended = reduce(start(), { data: { t: "end" } }, ctx(ANA, false));
    expect(reduce(ended, { data: { t: "join" } }, ctx(BO, true))).toBe(ended);
    expect(reduce(start(), { data: null }, ctx(BO, true)).present).toEqual({});
    expect(reduce(start(), { data: { t: "promote" } }, ctx(BO, true)).present).toEqual({});
  });
});

describe("player ids", () => {
  it("are the same for everyone in a session, and differ across sessions and salts", async () => {
    const a = await playerId(card.salt, card.sessionId, ANA);
    expect(a).toMatch(/^p_[A-Za-z0-9_-]{16}$/);
    expect(await playerId(card.salt, card.sessionId, ANA)).toBe(a);
    expect(await playerId(card.salt, card.sessionId, BO)).not.toBe(a);
    expect(await playerId(card.salt, "s_another_session", ANA)).not.toBe(a);
    expect(await playerId("anothersaltvalue", card.sessionId, ANA)).not.toBe(a);
  });

  it("never contain the DID", async () => {
    expect(await playerId(card.salt, card.sessionId, ANA)).not.toContain("zAna");
  });
});

describe("the bridge", () => {
  const frame = {};
  const origin = "https://je.frav.in";
  const msg = (data: unknown, over: Partial<{ source: unknown; origin: string }> = {}) =>
    readAppMessage({ source: frame, origin, data, ...over }, frame, origin);

  it("answers ready and close from its own iframe and origin", () => {
    expect(msg({ awful: 1, type: "ready" })).toEqual({ awful: 1, type: "ready" });
    expect(msg({ awful: 1, type: "close" })).toEqual({ awful: 1, type: "close" });
  });

  it("ignores other windows, other origins, other versions, unknown types and oversize messages", () => {
    expect(msg({ awful: 1, type: "ready" }, { source: {} })).toBeNull();
    expect(msg({ awful: 1, type: "ready" }, { origin: "https://evil.example" })).toBeNull();
    expect(msg({ awful: 2, type: "ready" })).toBeNull();
    expect(msg({ awful: 1, type: "attest" })).toBeNull();
    expect(msg("ready")).toBeNull();
    expect(msg({ awful: 1, type: "ready", pad: "x".repeat(MAX_MESSAGE_BYTES) })).toBeNull();
  });

  it("reads an advertised game, cleaned, and null to clear it", () => {
    expect(msg({ awful: 1, type: "activity", name: "  Jeopardy  " })).toEqual({ awful: 1, type: "activity", name: "Jeopardy" });
    expect(msg({ awful: 1, type: "activity", name: null })).toEqual({ awful: 1, type: "activity", name: null });
    expect(msg({ awful: 1, type: "activity", name: 42 })).toEqual({ awful: 1, type: "activity", name: null });
    expect(msg({ awful: 1, type: "activity", name: "\u0000\u200B" })).toEqual({ awful: 1, type: "activity", name: null });
  });

  it("holds an app to its rate", () => {
    let t = 0;
    const allow = rateLimiter(3, () => t);
    expect([allow(), allow(), allow(), allow()]).toEqual([true, true, true, false]);
    t = 1000;
    expect(allow()).toBe(true);
  });

  it("says hello with the session, what the starter typed, and players - nothing else", () => {
    const self = { id: "p_1", name: "Ana", color: null };
    const hello = helloMessage({ sessionId: "s_x", startedAt: 5, args: "ROOM42", self, players: [self], theme: "dark", locale: "pt-BR" });
    expect(hello).toEqual({
      awful: 1,
      type: "hello",
      session: { id: "s_x", startedAt: 5, args: "ROOM42" },
      self,
      players: [self],
      theme: "dark",
      locale: "pt-BR",
    });
  });
});
