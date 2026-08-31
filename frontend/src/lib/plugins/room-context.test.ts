import { describe, expect, it } from "vitest";
import { MessageType, type Message } from "$lib/types/message";
import {
  ROOM_CONTEXT_MAX_CHARS,
  ROOM_CONTEXT_MAX_IMAGES,
  ROOM_CONTEXT_MAX_MESSAGES,
  buildRoomContext,
} from "./room-context";

let seq = 0;
function msg(over: Partial<Message> = {}): Message {
  seq += 1;
  return {
    id: `m${seq}`,
    roomCode: "room-a",
    senderId: "alice-id",
    senderDid: "did:key:alice",
    senderName: "Alice",
    timestamp: 1000 + seq,
    lamport: seq,
    type: MessageType.Text,
    content: `hello ${seq}`,
    attachments: [],
    ...over,
  };
}

describe("buildRoomContext", () => {
  it("keeps human messages, excludes plugin and system rows", () => {
    const ctx = buildRoomContext([
      msg({ content: "real talk" }),
      msg({ type: MessageType.PluginCard, content: '{"pluginId":"x"}' }),
      msg({ type: MessageType.PluginUpdate, content: '{"cardId":"y"}' }),
      msg({ type: MessageType.Reaction, content: "" }),
      msg({ type: MessageType.Reply, content: "a reply" }),
    ]);
    expect(ctx.map((m) => m.text)).toEqual(["real talk", "a reply"]);
  });

  it("bounds message count newest-first and returns ascending", () => {
    const all = Array.from({ length: 10 }, (_, i) =>
      msg({ content: `n${i}` })
    );
    const ctx = buildRoomContext(all, { limit: 3 });
    expect(ctx.map((m) => m.text)).toEqual(["n7", "n8", "n9"]);
  });

  it("caps the limit at the hard maximum", () => {
    const all = Array.from({ length: ROOM_CONTEXT_MAX_MESSAGES + 20 }, () =>
      msg()
    );
    expect(buildRoomContext(all, { limit: 10_000 })).toHaveLength(
      ROOM_CONTEXT_MAX_MESSAGES
    );
  });

  it("trims long text and reply snapshots", () => {
    const ctx = buildRoomContext([
      msg({
        content: "x".repeat(ROOM_CONTEXT_MAX_CHARS + 500),
        replyTo: { id: "r1", senderName: "Bob", content: "y".repeat(500) },
        type: MessageType.Reply,
      }),
    ]);
    expect(ctx[0].text).toHaveLength(ROOM_CONTEXT_MAX_CHARS);
    expect(ctx[0].replyTo!.text.length).toBeLessThanOrEqual(200);
  });

  it("exposes image METADATA only, non-images excluded, globally capped", () => {
    const files = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        infoHash: `h${i}`,
        filename: `p${i}.png`,
        mimeType: "image/png",
        size: 10,
        width: 100,
        height: 50,
      }));
    const rows = [
      msg({
        type: MessageType.File,
        content: "",
        meta: {
          files: [
            ...files(2),
            {
              infoHash: "zip",
              filename: "a.zip",
              mimeType: "application/zip",
              size: 10,
            },
          ],
        },
      }),
      ...Array.from({ length: 40 }, () =>
        msg({ type: MessageType.File, content: "", meta: { files: files(1) } })
      ),
    ];
    const ctx = buildRoomContext(rows, { limit: 200 });
    const total = ctx.reduce((n, m) => n + m.images.length, 0);
    expect(total).toBe(ROOM_CONTEXT_MAX_IMAGES);
    expect(
      ctx.every((m) => m.images.every((i) => i.mimeType.startsWith("image/")))
    ).toBe(true);
    expect(ctx[0].images[0]).not.toHaveProperty("size");
  });

  it("drops rows with neither text nor images", () => {
    expect(
      buildRoomContext([msg({ content: "", meta: { files: [] } })])
    ).toHaveLength(0);
  });
});
