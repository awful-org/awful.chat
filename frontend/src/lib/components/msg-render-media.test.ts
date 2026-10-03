import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * What a message asks for and decodes by itself. The rules are tested where
 * they live - autoDownloadOnRender in files-hydration.test.ts, animatedView
 * in image-size.test.ts - and these check that MsgRender hands its files
 * and images to them, reading the component the way
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

describe("MsgRender's image viewer", () => {
  // A message shows a GIF past the bound as a placeholder, and a click on
  // it opened the url here in a plain img, decoding at full size the very
  // image the placeholder had refused.
  it("is told an image is animated exactly when the message's GifImage is", () => {
    expect(template).toMatch(/\{@const animated = file\.mimeType === "image\/gif"\}/);
    expect(template).toMatch(/openLightbox\(\{[^}]*size: file\.size,\s*animated,\s*\}\)/);
    expect(template).toMatch(/<GifImage\s+src=\{transfer\.blobURL\}[^>]*\{animated\}/);
    expect(template).toMatch(/openLightbox\(\{[^}]*mimeType: "image\/gif",\s*animated: true,\s*\}\)/);
    expect(template).toMatch(/<GifImage\s+src=\{content\}[^>]*animated=\{true\}/);
  });

  it("measures an animated image by GifImage's rule, and shows only the copy it measured", () => {
    expect(script).toMatch(/const lightboxView = \$derived\(\s*lightbox\?\.animated\s*\?\s*animatedView\(/);
    // The url goes into an img of its own for a still image alone.
    expect(template.match(/src=\{lightbox\.url\}/g)).toHaveLength(1);
    expect(template).toMatch(/\{#if !lightbox\.animated\}\s*<img\s+bind:this=\{imgEl\}\s+src=\{lightbox\.url\}/);
    expect(template).toMatch(/\{:else if lightboxLoaded\}[\s\S]*?\{@attach showCopy\(lightboxLoaded\)\}/);
    // Only once it is known to be within the bound.
    expect(template).toMatch(/\{#if lightboxKind === "image" && lightboxView !== "shown"\}/);
  });

  it("says an image past the bound is too large to show, and converts nothing it will not show", () => {
    expect(template).toContain("This image is too large to show.");
    expect(script).toMatch(/const lightboxFormats = \$derived\([^;]*lightboxView === "shown"/);
  });
});
