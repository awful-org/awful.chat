import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  clearStorageCrypto,
  initStorageCrypto,
} from "../storage-crypto";
import {
  getDiagChunks,
  listDiagSessions,
  pruneDiagnostics,
  putDiagChunk,
  wipeLocalDatabase,
  type DiagChunkRecord,
} from "../storage";
import {
  DIAG_KEEP_SESSIONS,
  clearStoredDiagnostics,
  flushNow,
  loadStoredSession,
  resetDiagStoreForTest,
  storedDiagSessions,
} from "./store";
import { diagPrefs, setDiagPersist } from "./prefs.svelte";
import { ev } from "./event";
import { beginSession, rec, resetRecorderForTest } from "./recorder";
import type { DiagEvent } from "./schema";

const TEST_KEY = new Uint8Array(32).fill(7);

function chunk(
  sessionId: string,
  chunkSeq: number,
  startedAt: number,
  events: DiagEvent[]
): DiagChunkRecord {
  const bytes = new TextEncoder().encode(JSON.stringify(events));
  return {
    id: `${sessionId}:${String(chunkSeq).padStart(6, "0")}`,
    sessionId,
    startedAt,
    seqFrom: events[0]?.seq ?? 0,
    seqTo: events[events.length - 1]?.seq ?? 0,
    data: bytes.slice().buffer,
  };
}

function event(seq: number, kind: DiagEvent["kind"] = "peer.connect"): DiagEvent {
  return {
    seq,
    t: seq * 10,
    kind,
    sev: "info",
    peer: "12D3KooWPEER",
    room: null,
  };
}

beforeEach(async () => {
  await initStorageCrypto(TEST_KEY);
  await wipeLocalDatabase();
  resetRecorderForTest();
  resetDiagStoreForTest();
  setDiagPersist(false);
});

afterEach(() => {
  clearStorageCrypto();
});

describe("the diagnostics store", () => {
  it("round-trips a chunk through the sealed store", async () => {
    await putDiagChunk(chunk("s1", 0, 1000, [event(1), event(2)]));
    const rows = await getDiagChunks("s1");
    expect(rows).toHaveLength(1);
    const text = new TextDecoder().decode(new Uint8Array(rows[0].data));
    expect(JSON.parse(text)).toHaveLength(2);
  });

  it("seals the events rather than storing them readable", async () => {
    // The events carry peer ids and error strings; a readable diagnostic store
    // would undo the sealed messages store one field over.
    await putDiagChunk(chunk("s1", 0, 1000, [event(1)]));
    const database = await (await import("../storage")).getDB();
    const raw = await database.get("diagnostics", "s1:000000");
    const sealed = new TextDecoder().decode(
      new Uint8Array(raw?.data as ArrayBuffer)
    );
    expect(sealed).not.toContain("12D3KooWPEER");
    expect(sealed).not.toContain("peer.connect");
  });

  it("keeps the clear fields readable so a prune needs no key", async () => {
    await putDiagChunk(chunk("s1", 0, 4242, [event(1)]));
    const sessions = await listDiagSessions();
    expect(sessions).toEqual([
      { sessionId: "s1", startedAt: 4242, chunks: 1, bytes: expect.any(Number) },
    ]);
  });

  it("returns a session's chunks oldest first, whatever the write order", async () => {
    await putDiagChunk(chunk("s1", 2, 1000, [event(9)]));
    await putDiagChunk(chunk("s1", 0, 1000, [event(1)]));
    await putDiagChunk(chunk("s1", 1, 1000, [event(5)]));
    const rows = await getDiagChunks("s1");
    expect(rows.map((r) => r.seqFrom)).toEqual([1, 5, 9]);
  });

  it("lists sessions newest first", async () => {
    await putDiagChunk(chunk("old", 0, 1000, [event(1)]));
    await putDiagChunk(chunk("new", 0, 5000, [event(1)]));
    expect((await listDiagSessions()).map((s) => s.sessionId)).toEqual([
      "new",
      "old",
    ]);
  });

  it("keeps exactly the newest N sessions", async () => {
    for (let i = 1; i <= 6; i++) {
      await putDiagChunk(chunk(`s${i}`, 0, i * 1000, [event(1)]));
    }
    const removed = await pruneDiagnostics(DIAG_KEEP_SESSIONS, 1024 * 1024);
    expect(removed).toBe(3);
    const kept = (await listDiagSessions()).map((s) => s.sessionId);
    expect(kept).toEqual(["s6", "s5", "s4"]);
  });

  it("drops a whole session, never a partial history", async () => {
    await putDiagChunk(chunk("s1", 0, 1000, [event(1)]));
    await putDiagChunk(chunk("s1", 1, 1000, [event(2)]));
    await putDiagChunk(chunk("s2", 0, 2000, [event(1)]));
    await pruneDiagnostics(1, 1024 * 1024);
    expect(await getDiagChunks("s1")).toEqual([]);
    expect(await getDiagChunks("s2")).toHaveLength(1);
  });

  it("prunes on total bytes as well as session count", async () => {
    const big = Array.from({ length: 200 }, (_, i) => event(i + 1));
    for (let i = 1; i <= 3; i++) {
      await putDiagChunk(chunk(`s${i}`, 0, i * 1000, big));
    }
    const removed = await pruneDiagnostics(DIAG_KEEP_SESSIONS, 100);
    expect(removed).toBeGreaterThan(0);
  });

  it("never prunes the session that is still recording", async () => {
    for (let i = 1; i <= 5; i++) {
      await putDiagChunk(chunk(`s${i}`, 0, i * 1000, [event(1)]));
    }
    await pruneDiagnostics(1, 1, "s1");
    expect(await getDiagChunks("s1")).toHaveLength(1);
  });
});

describe("flush policy", () => {
  it("writes nothing while the persist switch is off", async () => {
    beginSession("sess-off", 1000);
    rec(ev("session.start"));
    await flushNow();
    expect(await storedDiagSessions()).toEqual([]);
  });

  it("writes the ring once the switch is on", async () => {
    setDiagPersist(true);
    beginSession("sess-on", 1000);
    rec(ev("session.start"));
    rec(ev("peer.connect", { peer: "12D3KooWPEER" }));
    await flushNow();
    const sessions = await storedDiagSessions();
    expect(sessions.map((s) => s.sessionId)).toEqual(["sess-on"]);
  });

  it("marks the moment persistence became possible", async () => {
    // Boot, config and relay failures all happen before unlock, so the
    // persisted stream starts late. `session.unlock` is what says why.
    setDiagPersist(true);
    beginSession("sess-unlock", 1000);
    rec(ev("relay.dial.fail"));
    await flushNow();
    const events = await loadStoredSession("sess-unlock");
    expect(events.map((e) => e.kind)).toEqual([
      "relay.dial.fail",
      "session.unlock",
    ]);
  });

  it("writes only what is new on a second flush", async () => {
    setDiagPersist(true);
    beginSession("sess-inc", 1000);
    rec(ev("session.start"));
    await flushNow();
    rec(ev("peer.connect", { peer: "12D3KooWPEER" }));
    await flushNow();
    const chunks = await getDiagChunks("sess-inc");
    expect(chunks).toHaveLength(2);
    expect(chunks[1].seqFrom).toBeGreaterThan(chunks[0].seqTo);
    const events = await loadStoredSession("sess-inc");
    expect(new Set(events.map((e) => e.seq)).size).toBe(events.length);
  });

  it("does nothing on a flush with no new events", async () => {
    setDiagPersist(true);
    beginSession("sess-idle", 1000);
    rec(ev("session.start"));
    await flushNow();
    await flushNow();
    expect(await getDiagChunks("sess-idle")).toHaveLength(1);
  });

  it("starts a new chunk series for a new session", async () => {
    setDiagPersist(true);
    beginSession("sess-a", 1000);
    rec(ev("session.start"));
    await flushNow();
    beginSession("sess-b", 2000);
    rec(ev("session.start"));
    await flushNow();
    expect((await getDiagChunks("sess-b"))[0].id).toBe("sess-b:000000");
  });

  it("survives a write that fails, rather than throwing at the caller", async () => {
    setDiagPersist(true);
    beginSession("sess-fail", 1000);
    rec(ev("session.start"));
    // Locked storage: `requireKey` throws inside `sealRow`.
    clearStorageCrypto();
    await expect(flushNow()).resolves.toBeUndefined();
    await initStorageCrypto(TEST_KEY);
  });

  it("retries after unlock what it could not write before", async () => {
    setDiagPersist(true);
    beginSession("sess-late", 1000);
    rec(ev("relay.dial.fail"));
    clearStorageCrypto();
    await flushNow();
    expect(await storedDiagSessions()).toEqual([]);

    await initStorageCrypto(TEST_KEY);
    rec(ev("relay.dial.ok"));
    await flushNow();
    const events = await loadStoredSession("sess-late");
    expect(events.map((e) => e.kind)).toContain("relay.dial.fail");
    expect(events.map((e) => e.kind)).toContain("relay.dial.ok");
  });

  it("clears everything on request", async () => {
    setDiagPersist(true);
    beginSession("sess-clear", 1000);
    rec(ev("session.start"));
    await flushNow();
    await clearStoredDiagnostics();
    expect(await storedDiagSessions()).toEqual([]);
    expect(diagPrefs.persist).toBe(true);
  });
});
