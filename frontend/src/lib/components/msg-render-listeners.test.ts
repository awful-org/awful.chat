import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * MsgRender is mounted once per message on screen, so whatever it attaches
 * to the window, or to a media query, is multiplied by the length of the
 * conversation. It used to put a keydown listener on the window for each
 * message - to close its own image viewer on Escape - and every key typed
 * anywhere in the app ran all of them: some 20 ms a keystroke on a phone
 * with a couple of thousand messages loaded.
 *
 * There is no DOM in these tests, so this reads the component the way the
 * invite-card test reads nginx.conf.
 */
const source = readFileSync("src/lib/components/MsgRender.svelte", "utf8");
const moduleScript = source.match(/<script module[^>]*>([\s\S]*?)<\/script>/)![1];
const perMessage = source.slice(source.indexOf("</script>") + "</script>".length);

describe("MsgRender's per-message listeners", () => {
  it("puts no listener on the window for each message", () => {
    expect(perMessage).not.toContain("<svelte:window");
  });

  it("listens for Escape only while its viewer is open", () => {
    const listener = perMessage.match(
      /\$effect\(\(\) => \{\s*if \(!lightbox\) return;[\s\S]*?window\.addEventListener\("keydown"[\s\S]*?return \(\) => window\.removeEventListener\("keydown"/
    );
    expect(listener).not.toBeNull();
    expect(perMessage.match(/window\.addEventListener\(/g)).toHaveLength(1);
  });

  it("shares one media query between every message", () => {
    expect(moduleScript).toContain("new MediaQuery(");
    expect(perMessage).not.toMatch(/matchMedia\(|new MediaQuery\(/);
  });
});
