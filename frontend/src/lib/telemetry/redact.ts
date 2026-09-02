/**
 * Redaction primitives. Every identifier that must never leave the tab is
 * replaced by a bundle-local ordinal here, and nowhere else.
 *
 * Why ordinals and not a hash: a hash of a room code is a guessable
 * commitment - the code is only 64 bits and the hash would be stable across
 * bundles, so a collector holding two bundles could link rooms and, with a
 * dictionary, invert the code. An ordinal is meaningful only inside the one
 * bundle that defines it, which is exactly the amount of meaning a reader
 * needs: "these events are about the same room".
 */

import type { DiagRoomRef } from "./schema";

/** `"dm-" + hex(sha256(...))` - see `docs/spec.md` "Room Codes". */
const DM_PREFIX = "dm-";
/** The device-sync pseudo-room - see `transport/sync.svelte.ts`. */
const SYNC_PREFIX = "__sync_";

/**
 * Classify a room without revealing it. The prefix is the only thing read, and
 * the prefix is a documented structural fact, not a secret.
 */
export function roomKind(roomCode: string): "text" | "dm" | "sync" {
  if (roomCode.startsWith(SYNC_PREFIX)) return "sync";
  if (roomCode.startsWith(DM_PREFIX)) return "dm";
  return "text";
}

/**
 * The session's table, so `errText` in `event.ts` can scrub without importing
 * the recorder - the recorder imports `event.ts`, and that cycle is why the
 * scrub used to be the caller's job (and was forgotten at ~15 of them).
 * `recorder.ts` owns its lifetime and swaps it on every new session.
 */
let active: RefTable;

export function activeRefs(): RefTable {
  return active;
}

export function setActiveRefs(table: RefTable): void {
  active = table;
}

/**
 * Assigns and remembers bundle-local ordinals. One instance per session; a new
 * session gets a new table so ordinals never correlate across sessions.
 */
export class RefTable {
  #rooms = new Map<string, DiagRoomRef>();
  #identities = new Map<string, string>();
  #files = new Map<string, string>();
  #now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.#now = now;
  }

  /** "r1", "r2", ... Stable for the life of the table. */
  roomRef(roomCode: string): string {
    const hit = this.#rooms.get(roomCode);
    if (hit) return hit.ref;
    const ref = `r${this.#rooms.size + 1}`;
    this.#rooms.set(roomCode, {
      ref,
      kind: roomKind(roomCode),
      joinedAt: this.#now(),
    });
    return ref;
  }

  /**
   * "i1", "i2", ... Only a PROVEN peerId -> DID binding may call this: it is
   * what groups one person's devices, and a forged binding would group two
   * different people.
   */
  identityRef(did: string): string {
    const hit = this.#identities.get(did);
    if (hit) return hit;
    const ref = `i${this.#identities.size + 1}`;
    this.#identities.set(did, ref);
    return ref;
  }

  /** "f1", "f2", ... An infoHash names retrievable content, so it is redacted. */
  fileRef(infoHash: string): string {
    const hit = this.#files.get(infoHash);
    if (hit) return hit;
    const ref = `f${this.#files.size + 1}`;
    this.#files.set(infoHash, ref);
    return ref;
  }

  /**
   * The room table, INCLUDING the codes. NEVER serialized - `bundle.ts` copies
   * the `DiagRoomRef` half and drops the code.
   */
  knownRooms(): Array<{ ref: string; code: string; entry: DiagRoomRef }> {
    const out: Array<{ ref: string; code: string; entry: DiagRoomRef }> = [];
    for (const [code, entry] of this.#rooms) {
      out.push({ ref: entry.ref, code, entry });
    }
    return out;
  }

  /** The serializable room list. */
  rooms(): DiagRoomRef[] {
    return [...this.#rooms.values()].map((r) => ({ ...r }));
  }

  /**
   * Replace everything this table knows to be sensitive with its ordinal, and
   * every URL with a placeholder.
   *
   * For text this bundle did not compose: a thrown error's message, which can
   * quote the very things the schema has no field for. "Failed to fetch
   * https://relay.example/invite/<code>" is a real message from a real failure
   * path, and it would carry a room code out of a bundle that redacts room
   * codes everywhere else. URLs go first, so a code inside one is gone before
   * the per-code pass even looks.
   *
   * Only what this session actually touched can be replaced by an ordinal, so
   * a bare `did:key:` gets a blanket placeholder instead: an unbound identity
   * has no ordinal to become.
   */
  scrub(text: string): string {
    try {
      let out = text.replace(/\b[a-z][a-z0-9+.-]*:\/\/\S+/gi, "<url>");
      for (const [code, entry] of this.#rooms) {
        out = out.split(code).join(entry.ref);
      }
      for (const [did, ref] of this.#identities) {
        out = out.split(did).join(ref);
      }
      return out.replace(/did:key:[A-Za-z0-9]+/g, "<did>");
    } catch {
      // A hostile string subclass can throw from replace via Symbol.replace.
      return "<unprintable>";
    }
  }
}

active = new RefTable();
