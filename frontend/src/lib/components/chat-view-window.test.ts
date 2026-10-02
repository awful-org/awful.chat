import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * ChatView mounts a window of the rows it holds and lets go of rows far
 * back (chat-window.ts, where the rules are tested). These are the places
 * the view itself has to take part, read from the component the way
 * msg-render-listeners.test.ts reads MsgRender: there is no DOM in these
 * tests.
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

  // A quote whose message the view has let go of did nothing when clicked.
  it("finds a quoted message that is not held in storage", () => {
    const quoted = body("jumpToQuoted");
    expect(quoted).toContain("getMessage(messageId)");
    expect(quoted).toContain("revealMessage(room, quoted.id, quoted.lamport)");
    expect(source).toContain("onclick={() => void jumpToQuoted(msg.replyTo!.id)}");
  });
});
