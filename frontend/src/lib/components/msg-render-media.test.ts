import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What a message asks for by itself. The rule is tested where it lives -
 * autoDownloadOnRender in files-hydration.test.ts - and these check that
 * MsgRender hands its files to it, reading the component the way
 * msg-render-listeners.test.ts does: there is no DOM in these tests.
 */
const source = readFileSync("src/lib/components/MsgRender.svelte", "utf8");
const scriptStart = source.indexOf('<script lang="ts">');
const scriptEnd = source.indexOf("</script>", scriptStart);
const script = source.slice(scriptStart, scriptEnd);
const template = source.slice(scriptEnd, source.indexOf("<style>"));

describe("MsgRender's auto-download", () => {
  // It asks like a click, and a click decrypts a held file into memory
  // whatever its size: another member's held 2 GB video on the page was
  // decrypted as it rendered, though every other automatic ask stops at
  // AUTO_DOWNLOAD_MAX_BYTES.
  it("asks for another member's media only through the ceiling every automatic ask has", () => {
    const effect = script.match(
      /\$effect\(\(\) => \{\s*if \(isOwn\) return;\s*autoDownloadOnRender\(([\s\S]*?)\);\s*\}\);/
    );
    expect(effect).not.toBeNull();
    expect(effect![1]).toContain("onRequestFileDownload(file, msg.senderId)");
    // Nothing else in the script asks; the rest are Download buttons.
    expect(script.match(/onRequestFileDownload\(/g)).toHaveLength(1);
  });

  // A held file the page does not show by itself (past the ceiling, or not
  // a picture, video or sound) is shown from here by its Download button,
  // on the user's own messages too.
  it("offers a file's Download buttons on the user's own messages as well", () => {
    const files = template.slice(
      template.indexOf("{#if isFileMessage}"),
      template.indexOf("{:else if isGifMessage}")
    );
    expect(files).toMatch(/onclick=\{\(\) => onRequestFileDownload\(file, msg\.senderId\)\}/);
    expect(files).not.toContain("isOwn");
  });
});
