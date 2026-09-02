/**
 * The only place a `DiagEvent` is constructed, which makes it the only place
 * the redaction contract can be violated. Read `schema.ts`'s header before
 * changing anything here.
 *
 * `ev` MUST NOT throw for ANY input. It is called from inside `catch` blocks,
 * from event emitters and from a `finally`, so a throw here would turn a
 * diagnosable bug into an undiagnosable one.
 */

import { activeRefs } from "./redact";
import {
  KIND_SEV,
  type DiagEvent,
  type DiagKind,
  type DiagSeverity,
} from "./schema";

export const MAX_DETAIL_KEYS = 12;
export const MAX_DETAIL_STRING = 200;

type DetailValue = string | number | boolean | null;

/**
 * Coerce one detail value to a JSON primitive.
 *
 * `JSON.stringify` is deliberately NOT used: a circular object throws, a
 * getter can throw, and a `BigInt` throws. `Object.prototype.toString.call`
 * cannot throw for any value.
 */
function coerce(v: unknown): DetailValue | undefined {
  if (v === null) return null;
  if (v === undefined) return undefined;
  const t = typeof v;
  if (t === "string") return (v as string).slice(0, MAX_DETAIL_STRING);
  if (t === "number") return Number.isFinite(v as number) ? (v as number) : null;
  if (t === "boolean") return v as boolean;
  try {
    return Object.prototype.toString.call(v).slice(0, MAX_DETAIL_STRING);
  } catch {
    // A Proxy can throw from a trap even here.
    return null;
  }
}

/**
 * Build an event body. `seq` and `t` are assigned by the ring, so a caller
 * cannot forge an ordering.
 */
export function ev(
  kind: DiagKind,
  opts?: {
    peer?: string | null;
    room?: string | null;
    sev?: DiagSeverity;
    d?: Record<string, unknown>;
  }
): Omit<DiagEvent, "seq" | "t"> {
  let peer: string | null = null;
  let room: string | null = null;
  let sev: DiagSeverity = KIND_SEV[kind] ?? "info";
  let d: Record<string, DetailValue> | undefined;

  try {
    if (opts) {
      if (typeof opts.peer === "string") peer = opts.peer;
      if (typeof opts.room === "string") room = opts.room;
      if (opts.sev) sev = opts.sev;
      if (opts.d) {
        const out: Record<string, DetailValue> = {};
        let n = 0;
        for (const key in opts.d) {
          if (n >= MAX_DETAIL_KEYS) break;
          let raw: unknown;
          try {
            raw = opts.d[key];
          } catch {
            // A getter or a Proxy trap threw.
            raw = null;
          }
          const value = coerce(raw);
          if (value === undefined) continue;
          out[key.slice(0, MAX_DETAIL_STRING)] = value;
          n++;
        }
        if (n > 0) d = out;
      }
    }
  } catch {
    // Iterating a hostile object failed. Keep the event, lose the detail.
  }

  return d ? { kind, sev, peer, room, d } : { kind, sev, peer, room };
}

/**
 * A one-line, bounded, SCRUBBED description of a thrown value.
 *
 * NEVER a stack: a stack carries local filesystem paths and, in a bundled
 * build, source-map hints about the user's own machine.
 *
 * The scrub is here and not at the call sites because that is where it was:
 * one of the ~16 places that record an error text remembered it, and the
 * other fifteen wrote "Failed to fetch https://relay.example/invite/<code>"
 * into a bundle that redacts room codes everywhere else. A caller cannot
 * forget something it does not do.
 *
 * Scrub BEFORE truncating: cutting at 200 characters first can leave half a
 * `did:key:` behind, and half an identifier is still an identifier.
 *
 * `activeRefs` comes from `redact.ts`, not from the recorder that owns the
 * table: the recorder imports this module, so reaching for `refs()` here
 * would close a cycle.
 */
export function errText(err: unknown): string {
  try {
    const raw =
      err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    return activeRefs().scrub(raw).slice(0, MAX_DETAIL_STRING);
  } catch {
    // `String()` calls `toString`, which a hostile object can override.
    return "unknown";
  }
}
