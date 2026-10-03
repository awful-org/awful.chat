// The DM list's storage reads, lifted out of AppView.svelte so they can be
// tested: a component cannot be mounted in these tests.
//
// The list used to be rebuilt from storage for every conversation on every
// change anywhere - each DM received or sent, each room opened, each profile
// frame from any peer - reading and decrypting every conversation's newest
// message and unread backlog. Most of those changes touch one conversation or
// none. So each conversation's reads are kept, and read again only when a row
// was stored into it or its read mark moved.
//
// Rebuilding on DM events alone left the list stale wherever a row is stored
// with no event after it: a file or card collected from the mailbox, a
// history push that stopped before its SyncComplete, our own app update sent
// from a pinned widget into a conversation that is not open. The profile
// frames that used to rebuild the list all the time had hidden that. So a
// stored row also builds the list again, soon after, whichever path stored
// it.
import type { Message } from "$lib/types/message";

/**
 * How soon a stored row builds the list again - and at most that often, so a
 * history push, a batch every 150ms, costs one build a second rather than one
 * per batch. A path that tells the list itself (dmVersion) is not delayed:
 * the build this brings after it then finds nothing left to read.
 */
export const DM_STORED_REBUILD_MS = 1_000;

export interface DmConversation {
  roomCode: string;
  lastSeenLamport: number;
}

export interface DmConversationReads {
  last: Message | undefined;
  unread: number;
}

interface Kept extends DmConversationReads {
  seen: number;
  stored: number;
}

export class DmInboxReads {
  private kept = new Map<string, Kept>();
  /** Rows stored per conversation this session: a new one makes its reads stale. */
  private stored = new Map<string, number>();
  private rebuildTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    private readonly deps: {
      lastMessage: (roomCode: string) => Promise<Message | undefined>;
      unreadCount: (roomCode: string, lastSeenLamport: number) => Promise<number>;
      /** Build the list again: rows were stored (DM_STORED_REBUILD_MS). */
      rebuild?: () => void;
    },
    private readonly rebuildMs = DM_STORED_REBUILD_MS
  ) {}

  /**
   * A row was stored: that conversation, if it is one, has to be read again,
   * and the list built again soon.
   */
  noteStored(roomCode: string): void {
    if (!roomCode.startsWith("dm-")) return;
    this.stored.set(roomCode, (this.stored.get(roomCode) ?? 0) + 1);
    if (!this.deps.rebuild || this.rebuildTimer) return;
    this.rebuildTimer = setTimeout(() => {
      this.rebuildTimer = null;
      this.deps.rebuild?.();
    }, this.rebuildMs);
  }

  /** The list is gone: a build still waiting is dropped. */
  dispose(): void {
    if (this.rebuildTimer) clearTimeout(this.rebuildTimer);
    this.rebuildTimer = null;
  }

  /**
   * Each conversation's newest message and unread count, from storage only
   * where something changed. Null when `alive` turns false: a newer build has
   * started, and this one stops reading instead of finishing for nothing.
   */
  async read(
    conversations: readonly DmConversation[],
    alive: () => boolean
  ): Promise<Map<string, DmConversationReads> | null> {
    const listed = new Set(conversations.map((c) => c.roomCode));
    for (const roomCode of this.kept.keys()) {
      if (!listed.has(roomCode)) this.kept.delete(roomCode);
    }
    const out = new Map<string, DmConversationReads>();
    for (const c of conversations) {
      // Taken before reading: a row stored while the reads run makes the
      // next build read again.
      const stored = this.stored.get(c.roomCode) ?? 0;
      let kept = this.kept.get(c.roomCode);
      if (!kept || kept.stored !== stored || kept.seen !== c.lastSeenLamport) {
        const last = await this.deps.lastMessage(c.roomCode);
        // A conversation with no message is not listed: no count to read.
        const unread = last ? await this.deps.unreadCount(c.roomCode, c.lastSeenLamport) : 0;
        if (!alive()) return null;
        kept = { last, unread, seen: c.lastSeenLamport, stored };
        this.kept.set(c.roomCode, kept);
      }
      out.set(c.roomCode, { last: kept.last, unread: kept.unread });
    }
    return out;
  }
}
