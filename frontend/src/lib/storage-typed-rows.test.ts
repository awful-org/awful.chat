import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  bulkPutMessages,
  deleteMessagesForRoom,
  getDB,
  getMessagesOfTypes,
  getPluginCardMessages,
  putMessage,
} from "./storage";
import { notifyIdentityLock } from "./identity/lock-events";
import { MessageType, type ChatMessageType, type Message } from "./types/message";

/**
 * Typed reads (plugin cards, plugin updates, reactions) used to be a getAll
 * over every row of the room each - one per card on a room open, one per
 * call-tile scan, one per reaction click. A whole-room read is a getAll on
 * the messages index, so that is what these count.
 */
const getAll = vi.spyOn(IDBIndex.prototype, "getAll");

let seq = 0;
function row(roomCode: string, type: ChatMessageType, lamport: number, content = "x"): Message {
  seq += 1;
  return {
    id: `m-${String(seq).padStart(5, "0")}`,
    roomCode,
    senderId: "did:key:zSender",
    senderName: "S",
    timestamp: lamport,
    lamport,
    type,
    content,
    attachments: [],
  };
}

/** A room of chat with a few plugin cards, updates and reactions in it. */
async function seed(roomCode: string): Promise<Message[]> {
  const rows: Message[] = [];
  for (let i = 0; i < 40; i++) rows.push(row(roomCode, MessageType.Text, i + 1, `hello ${i}`));
  for (let i = 0; i < 3; i++) rows.push(row(roomCode, MessageType.PluginCard, 100 + i, `{"pluginId":"poll","data":${i}}`));
  for (let i = 0; i < 5; i++) {
    rows.push(row(roomCode, MessageType.PluginUpdate, 200 + i, `{"pluginId":"poll","cardId":"c","data":${i}}`));
  }
  for (let i = 0; i < 4; i++) rows.push(row(roomCode, MessageType.Reaction, 300 + i));
  await bulkPutMessages(rows);
  return rows;
}

const ids = (rows: Message[]) => rows.map((m) => m.id);
const reads = () => getAll.mock.calls.length;
const PLUGIN_ROWS: ChatMessageType[] = [MessageType.PluginCard, MessageType.PluginUpdate];

beforeEach(async () => {
  const db = await getDB();
  await db.clear("messages");
  // A cleared store is a change nothing announced: the counts the cache
  // checks against notice, so each test starts from a fresh read anyway.
  getAll.mockClear();
});

describe("typed reads", () => {
  it("answer a room's repeat reads from memory", async () => {
    const rows = await seed("room-a");
    const first = await getMessagesOfTypes("room-a", PLUGIN_ROWS);
    expect(ids(first)).toEqual(ids(rows.filter((r) => PLUGIN_ROWS.includes(r.type))));
    expect(first.map((m) => m.content)).toContain('{"pluginId":"poll","data":2}');
    const afterFirst = reads();
    expect(afterFirst).toBeGreaterThan(0);

    for (let i = 0; i < 20; i++) {
      expect(ids(await getMessagesOfTypes("room-a", PLUGIN_ROWS))).toEqual(ids(first));
      expect(ids(await getPluginCardMessages("room-a"))).toEqual(ids(first).slice(0, 3));
    }
    expect(reads()).toBe(afterFirst);
  });

  // The room-open burst: every card on screen asks at once.
  it("share one read among everyone asking at once", async () => {
    await seed("room-a");
    await seed("room-b");
    await getMessagesOfTypes("room-b", PLUGIN_ROWS);
    const oneRead = reads();
    getAll.mockClear();

    const answers = await Promise.all(
      Array.from({ length: 25 }, () => getMessagesOfTypes("room-a", PLUGIN_ROWS))
    );
    expect(new Set(answers.map((a) => ids(a).join()))).toHaveLength(1);
    expect(reads()).toBe(oneRead);
  });

  it("keep up with rows stored after the read, without reading the room again", async () => {
    await seed("room-a");
    const snapshot: { version?: number } = {};
    await getMessagesOfTypes("room-a", PLUGIN_ROWS, snapshot);
    const before = snapshot.version;
    const warm = reads();

    const card = row("room-a", MessageType.PluginCard, 500, '{"pluginId":"app","data":{}}');
    await putMessage(card);
    // Chat in the room moves its row count; the cache saw that write too.
    await putMessage(row("room-a", MessageType.Text, 501));

    const cards = await getPluginCardMessages("room-a", snapshot);
    expect(cards.at(-1)?.id).toBe(card.id);
    expect(cards.at(-1)?.content).toBe(card.content);
    expect(snapshot.version).not.toBe(before);
    expect(reads()).toBe(warm);

    // Same rows, same version: a caller can keep what it built from them.
    const again: { version?: number } = {};
    await getPluginCardMessages("room-a", again);
    expect(again.version).toBe(snapshot.version);
  });

  it("read again when rows go away behind their back", async () => {
    await seed("room-a");
    expect(await getPluginCardMessages("room-a")).toHaveLength(3);
    const warm = reads();

    await deleteMessagesForRoom("room-a");
    expect(await getPluginCardMessages("room-a")).toEqual([]);
    expect(reads()).toBeGreaterThan(warm);

    // A room joined again starts from what is really stored.
    const card = row("room-a", MessageType.PluginCard, 7, '{"pluginId":"poll","data":{}}');
    await putMessage(card);
    expect(ids(await getPluginCardMessages("room-a"))).toEqual([card.id]);
  });

  // P03.5: the prior of every reaction click was a whole-room read.
  it("answer reaction clicks without reading the room", async () => {
    await seed("room-a");
    expect(await getMessagesOfTypes("room-a", [MessageType.Reaction])).toHaveLength(4);
    const warm = reads();
    const reaction = row("room-a", MessageType.Reaction, 600);
    await putMessage(reaction);
    for (let i = 0; i < 10; i++) {
      const all = await getMessagesOfTypes("room-a", [MessageType.Reaction]);
      expect(all).toHaveLength(5);
      expect(all.at(-1)?.id).toBe(reaction.id);
    }
    expect(reads()).toBe(warm);
  });

  it("keep rooms apart", async () => {
    await seed("room-a");
    await seed("room-b");
    await getPluginCardMessages("room-a");
    await getPluginCardMessages("room-b");
    await putMessage(row("room-a", MessageType.PluginCard, 900, '{"pluginId":"poll","data":{}}'));
    expect(await getPluginCardMessages("room-a")).toHaveLength(4);
    expect(await getPluginCardMessages("room-b")).toHaveLength(3);
  });

  it("order like the index: lamport, then id", async () => {
    const a = row("room-a", MessageType.PluginCard, 5, '{"pluginId":"poll"}');
    const b = row("room-a", MessageType.PluginCard, 5, '{"pluginId":"poll"}');
    const c = row("room-a", MessageType.PluginCard, 4, '{"pluginId":"poll"}');
    await bulkPutMessages([b, a]);
    await getPluginCardMessages("room-a");
    await putMessage(c);
    expect(ids(await getPluginCardMessages("room-a"))).toEqual([c.id, a.id, b.id]);
  });

  it("are dropped on lock, decrypted text and all", async () => {
    await seed("room-a");
    await getPluginCardMessages("room-a");
    const warm = reads();
    notifyIdentityLock();
    expect(await getPluginCardMessages("room-a")).toHaveLength(3);
    expect(reads()).toBeGreaterThan(warm);
  });
});
