import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * ChatView mounts a window of the rows it holds and lets go of rows far
 * back (chat-window.ts, where the rules are tested). These are the places
 * the view itself has to take part, read from the component the way
 * msg-render-listeners.test.ts reads MsgRender: there is no DOM in these
 * tests. They check the wiring only - that the view hands the rule what it
 * needs - and what comes of it was checked in a browser.
 */
const source = readFileSync("src/lib/components/ChatView.svelte", "utf8");

function body(name: string): string {
  const start = source.indexOf(`function ${name}(`);
  expect(start, name).toBeGreaterThan(-1);
  return source.slice(start, source.indexOf("\n  }\n", start));
}

describe("ChatView's window over the rows it holds", () => {
  // Replying to a message far back and going back to the newest trimmed the
  // message away: the banner went, and the reply went out as a plain one.
  it("never trims away the message being replied to", () => {
    expect(body("trimHeld")).toContain("trimPoint(visibleMessages, replyTarget)");
  });

  // Selecting the room already on screen re-joins it, which empties the
  // list and reloads the newest page under the same roomCode.
  it("lets go of a held window when the list empties", () => {
    expect(source).toMatch(
      /\$effect\(\(\) => \{\s*if \(visibleMessages\.length > 0\) return;\s*chatWindow = null;/
    );
  });

  // A quote, a plugin card's "go to" or a plugin's openMessage naming a row
  // the view had let go of did nothing. Every jump goes one way: planJump
  // decides (chat-window.test.ts), revealStored reads storage
  // (reveal-message.test.ts).
  it("sends every jump through the one path that reads storage", () => {
    const jump = body("jumpToMessage");
    expect(jump).toContain("planJump(visibleMessages, range, messageId, revealed)");
    expect(jump).toContain('if (plan.kind === "reveal") void revealStored(roomCode, messageId);');
    expect(source).toContain("untrack(() => jumpToMessage(jump.messageId, jump.revealed));");
    expect(source).toContain("onclick={() => jumpToMessage(msg.replyTo!.id)}");
  });
});
