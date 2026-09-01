/**
 * Optional persistence for the flight recorder.
 *
 * The recorder itself is always on, in memory. This module is one of its three
 * gated exits, and it runs ONLY while `diagPrefs.persist` is on.
 *
 * Ordering matters here. `blindValue` and `requireKey` throw before unlock, and
 * boot, config and relay failures happen exactly then - so the earliest and
 * most valuable events cannot be written when they occur. They stay in the ring
 * and are flushed on the first tick after unlock, and a `session.unlock` event
 * marks the moment, so a reader knows why the persisted stream starts late.
 */

import {
  deleteDiagnostics,
  getDiagChunks,
  listDiagSessions,
  pruneDiagnostics,
  putDiagChunk,
  type DiagChunkRecord,
  type DiagSessionSummary,
} from "../storage";
import { storageCryptoReady } from "../storage-crypto";
import { errText, ev } from "./event";
import { diagPrefs } from "./prefs.svelte";
import { rec, recorderSnapshot } from "./recorder";
import type { DiagEvent } from "./schema";

/** Sessions kept on disk. Three covers "it broke, I reloaded, it broke again". */
export const DIAG_KEEP_SESSIONS = 3;
/** Total sealed bytes kept. Beyond this the oldest session goes, whole. */
export const DIAG_MAX_BYTES = 8 * 1024 * 1024;
/** Flush cadence. */
export const DIAG_FLUSH_MS = 10_000;
/** Flush early once this many events are unwritten. */
export const DIAG_FLUSH_EVENTS = 512;

let timer: ReturnType<typeof setInterval> | null = null;
let flushedThrough = 0;
let chunkSeq = 0;
let sawUnlock = false;
let flushing = false;
let sessionId = "";

/** Idempotent. Safe to call before unlock and before a session exists. */
export function startDiagPersistence(): void {
  if (timer !== null) return;
  timer = setInterval(() => {
    void maybeFlush();
  }, DIAG_FLUSH_MS);
}

export function stopDiagPersistence(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

/** Called by the recorder's own taps whenever the ring grew. */
export function noteDiagGrowth(): void {
  const snap = recorderSnapshot();
  if (snap.nextSeq - flushedThrough > DIAG_FLUSH_EVENTS) void maybeFlush();
}

/**
 * Write everything not yet written. Never throws: a storage failure becomes one
 * `storage.quota` event and one console warning.
 */
export async function flushNow(): Promise<void> {
  await maybeFlush();
}

async function maybeFlush(): Promise<void> {
  if (!diagPrefs.persist) return;
  if (!storageCryptoReady()) return;
  // One flush at a time. Two overlapping flushes would both read the same
  // `flushedThrough` and write the same events under two chunk ids.
  if (flushing) return;

  let snap = recorderSnapshot();
  if (!snap.sessionId) return;

  if (snap.sessionId !== sessionId) {
    sessionId = snap.sessionId;
    flushedThrough = 0;
    chunkSeq = 0;
    sawUnlock = false;
  }

  if (!sawUnlock) {
    sawUnlock = true;
    // Recorded, then re-read, so it lands in the FIRST chunk and explains the
    // gap that precedes it. A snapshot taken before this call would push the
    // event into the next chunk, and a flush with nothing else to say would
    // write a chunk holding only this one event.
    rec(ev("session.unlock"));
    snap = recorderSnapshot();
  }

  const pending = snap.events.filter((e) => e.seq > flushedThrough);
  if (pending.length === 0) return;

  flushing = true;
  try {
    const record: DiagChunkRecord = {
      id: `${snap.sessionId}:${String(chunkSeq).padStart(6, "0")}`,
      sessionId: snap.sessionId,
      startedAt: snap.startedAt,
      seqFrom: pending[0].seq,
      seqTo: pending[pending.length - 1].seq,
      data: encodeEvents(pending),
    };
    await putDiagChunk(record);
    chunkSeq++;
    flushedThrough = record.seqTo;
    await pruneDiagnostics(
      DIAG_KEEP_SESSIONS,
      DIAG_MAX_BYTES,
      snap.sessionId
    );
  } catch (err) {
    rec(ev("storage.quota", { d: { err: errText(err), what: "diag-chunk" } }));
    console.warn("[diag] chunk not persisted:", err);
  } finally {
    flushing = false;
  }
}

function encodeEvents(events: DiagEvent[]): ArrayBuffer {
  const bytes = new TextEncoder().encode(JSON.stringify(events));
  // A fresh, exactly sized buffer: a TextEncoder result can be a view into a
  // larger pool, and IndexedDB would store the whole pool.
  return bytes.slice().buffer;
}


/** Every stored session, newest first. For the Diagnostics pane. */
export async function storedDiagSessions(): Promise<DiagSessionSummary[]> {
  try {
    return await listDiagSessions();
  } catch (err) {
    console.warn("[diag] could not list stored sessions:", err);
    return [];
  }
}

/** One stored session's events, oldest first, gaps and all. */
export async function loadStoredSession(id: string): Promise<DiagEvent[]> {
  try {
    const chunks = await getDiagChunks(id);
    const out: DiagEvent[] = [];
    for (const chunk of chunks) {
      const text = new TextDecoder().decode(new Uint8Array(chunk.data));
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) out.push(...(parsed as DiagEvent[]));
    }
    out.sort((a, b) => a.seq - b.seq);
    return out;
  } catch (err) {
    console.warn("[diag] could not read stored session:", err);
    return [];
  }
}

/** Drop every stored chunk. The pane's "Clear stored diagnostics" action. */
export async function clearStoredDiagnostics(): Promise<void> {
  try {
    await deleteDiagnostics();
    flushedThrough = 0;
    chunkSeq = 0;
    sessionId = "";
  } catch (err) {
    console.warn("[diag] could not clear stored diagnostics:", err);
  }
}

export function resetDiagStoreForTest(): void {
  stopDiagPersistence();
  flushedThrough = 0;
  chunkSeq = 0;
  sawUnlock = false;
  flushing = false;
  sessionId = "";
}
