import { describe, it, expect } from "vitest";
import { errText, ev, MAX_DETAIL_KEYS, MAX_DETAIL_STRING } from "./event";
import { activeRefs } from "./redact";

describe("ev", () => {
  it("resolves the default severity from the kind", () => {
    expect(ev("relay.dial.fail").sev).toBe("error");
    expect(ev("peer.rtt").sev).toBe("debug");
    expect(ev("session.start").sev).toBe("info");
  });

  it("lets a caller override the severity", () => {
    expect(ev("session.config", { sev: "warn" }).sev).toBe("warn");
  });

  it("defaults peer and room to null, never undefined", () => {
    // A `DiagEvent` with `peer: undefined` loses the field through
    // `JSON.stringify`, and the dashboard distinguishes "not about a peer"
    // from "unknown peer".
    expect(ev("session.start")).toEqual({
      kind: "session.start",
      sev: "info",
      peer: null,
      room: null,
    });
  });

  it("truncates a long string to exactly the limit", () => {
    const e = ev("session.config", { d: { s: "x".repeat(1000) } });
    expect((e.d?.s as string).length).toBe(MAX_DETAIL_STRING);
  });

  it("drops keys past the detail limit in insertion order", () => {
    const d: Record<string, number> = {};
    for (let i = 1; i <= 20; i++) d[`k${i}`] = i;
    const e = ev("counters", { d });
    expect(Object.keys(e.d ?? {})).toHaveLength(MAX_DETAIL_KEYS);
    expect(e.d?.k1).toBe(1);
    expect(e.d?.k13).toBeUndefined();
  });

  it("drops an empty detail bag entirely", () => {
    expect(ev("session.start", { d: {} }).d).toBeUndefined();
    expect(ev("session.start", { d: { gone: undefined } }).d).toBeUndefined();
  });

  it("replaces a non-finite number with null rather than losing the key", () => {
    const e = ev("peer.rtt", { d: { a: NaN, b: Infinity, c: -0 } });
    expect(e.d).toEqual({ a: null, b: null, c: -0 });
  });

  it("never throws for a circular object", () => {
    const circular: Record<string, unknown> = { name: "loop" };
    circular.self = circular;
    const e = ev("session.config", { d: { circular } });
    expect(e.d?.circular).toBe("[object Object]");
  });

  it("never throws for a Symbol, a BigInt or a function", () => {
    const e = ev("session.config", {
      d: { sym: Symbol("s"), big: 10n, fn: () => 1 },
    });
    expect(e.d?.sym).toBe("[object Symbol]");
    expect(e.d?.big).toBe("[object BigInt]");
    expect(e.d?.fn).toBe("[object Function]");
  });

  it("never throws for a Proxy that throws on get", () => {
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error("no");
        },
        ownKeys() {
          throw new Error("no");
        },
      }
    );
    const e = ev("session.config", { d: hostile as Record<string, unknown> });
    expect(e.kind).toBe("session.config");
  });

  it("never throws when a getter on the detail bag throws", () => {
    const d = {
      get boom(): string {
        throw new Error("no");
      },
      fine: 1,
    };
    const e = ev("session.config", { d });
    expect(e.d?.fine).toBe(1);
    expect(e.d?.boom).toBeNull();
  });

  it("keeps a 1 MB string bounded", () => {
    const e = ev("session.config", { d: { s: "y".repeat(1024 * 1024) } });
    expect((e.d?.s as string).length).toBe(MAX_DETAIL_STRING);
  });
});

describe("errText", () => {
  it("names an Error without its stack", () => {
    const err = new TypeError("bad thing");
    expect(errText(err)).toBe("TypeError: bad thing");
    expect(errText(err)).not.toContain("at ");
  });

  it("stringifies a non-Error", () => {
    expect(errText("plain")).toBe("plain");
    expect(errText(undefined)).toBe("undefined");
  });

  it("truncates a huge message", () => {
    expect(errText(new Error("z".repeat(5000))).length).toBe(MAX_DETAIL_STRING);
  });

  it("survives an object whose toString throws", () => {
    const hostile = {
      toString() {
        throw new Error("no");
      },
    };
    expect(errText(hostile)).toBe("unknown");
  });

  // The scrub used to be the caller's job and fifteen callers did not do it.
  // A thrown message quotes whatever the platform was handed, which on the
  // invite path is a room code and on the DM path is a DID.
  it("scrubs a room code and a did:key out of the message", () => {
    const code = "6BMB3GST2JRJZ";
    const ref = activeRefs().roomRef(code);
    const out = errText(
      new Error(`join ${code} failed for did:key:z6MkExampleIdentity`)
    );
    expect(out).not.toContain(code);
    expect(out).toContain(ref);
    expect(out).not.toContain("z6MkExampleIdentity");
    expect(out).toContain("<did>");
  });

  it("scrubs a url, so a code inside one never survives", () => {
    const out = errText(new Error("Failed to fetch https://relay.test/i/ABC"));
    expect(out).toBe("Error: Failed to fetch <url>");
  });
});
