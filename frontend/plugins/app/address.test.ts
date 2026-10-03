import { render } from "svelte/server";
import { describe, expect, it } from "vitest";
import type { HostApi } from "$lib/plugins/api";
import type { Message } from "$lib/types/message";
import AppCard from "./AppCard.svelte";
import AppTile from "./AppTile.svelte";
import { initialState } from "./logic";

// 63 characters, every label DNS-valid: the shape the finding used.
const SPOOF = "https://awful.chat.securesessionverificationformembersonly.attacker.net/unlock?x=1";
const HOST = new URL(SPOOF).host;

const card = { id: "card1", roomCode: "room-1", timestamp: 1 } as Message;
const cardState = initialState(
  { url: SPOOF, sessionId: "s_abcdefghijkl", salt: "saltsaltsaltsalt", args: "" },
  { senderDid: "did:key:zMallory" },
);
const host = {
  selfDid: () => "did:key:zAna",
  selfName: () => "Ana",
  cards: async () => [],
  onCardStateChange: () => () => {},
  sendUpdate: async () => {},
} as unknown as HostApi;

/** Every element whose own text includes the host, as its opening tag. */
function hostSpots(html: string): string[] {
  const spots: string[] = [];
  const re = /<(\w+)([^>]*)>([^<]*)/g;
  for (let m = re.exec(html); m; m = re.exec(html)) {
    if (m[3].includes(HOST)) spots.push(`<${m[1]}${m[2]}>`);
  }
  return spots;
}

/** The start-cutting box: right to left, the name an isolated LTR run. */
const BOX = `<span dir="rtl" class="min-w-0 truncate"><bdi dir="ltr">${HOST}</bdi>`;

/**
 * Wherever the host can be cut, it is cut at the start, so the end that
 * names the site (attacker.net) stays. Anywhere else it must wrap whole.
 */
function expectStartElided(html: string): number {
  const boxes = html.split(BOX).length - 1;
  for (const spot of hostSpots(html)) {
    if (spot === '<bdi dir="ltr">') continue;
    // A plain end-cut box around the host is exactly the bug.
    expect(spot).not.toMatch(/truncate|overflow|nowrap|ellipsis/);
    expect(spot).toMatch(/break-all/);
  }
  expect(hostSpots(html).filter((s) => s === '<bdi dir="ltr">')).toHaveLength(boxes);
  return boxes;
}

describe("an app's address keeps the end that names the site", () => {
  it("in the chat card", () => {
    const { body } = render(AppCard, { props: { card, cardState, host } });
    // The site line and the address line.
    expect(expectStartElided(body)).toBe(2);
  });

  it("in the tile's address strip and its disclosure", () => {
    const { body } = render(AppTile, {
      props: { card, cardState, host, chromeVisible: true, focused: false, setFocused: () => {} },
    });
    // The strip, the disclosure's title and its address line.
    expect(expectStartElided(body)).toBe(3);
  });

  it("with the path after the host, giving way first", () => {
    const { body } = render(AppCard, { props: { card, cardState, host } });
    const path = '<span class="min-w-0 truncate" style="flex-shrink: 1000">/unlock?x=1</span>';
    const after = body.slice(body.lastIndexOf(BOX));
    expect(after.indexOf(path)).toBeGreaterThan(0);
    // Same address line: only the host's own box closes in between.
    expect(after.slice(0, after.indexOf(path)).match(/<\/span>/g)).toHaveLength(1);
  });
});
