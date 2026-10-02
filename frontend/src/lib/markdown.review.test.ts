import { describe, expect, it } from "vitest";
import { firstLinkedUrl, renderMessageMarkdown } from "./markdown";

// From the review of fix/messages-media-review: masked links that drew as an
// address. Each case rendered a clickable label that read as a trusted host
// while it opened https://evil.example/login.

const md = (s: string) => renderMessageMarkdown(s, (d) => d);
const anchorTexts = (html: string) => [...html.matchAll(/<a [^>]*>([^]*?)<\/a>/g)].map((m) => m[1]);
const evil = "https://evil.example/login";

describe("review (major): a label split across adjacent masked links", () => {
  it("does not draw paypal.com out of two masked links that touch", () => {
    // Neither label reads as an address on its own ("paypal", ".com"), so
    // both were masked: two anchors, same class, nothing between them. In
    // Chromium and Firefox this drew exactly like a link labelled
    // "paypal.com".
    for (const src of [
      `[paypal](${evil})[.com](${evil})`,
      `[paypal.](${evil})[com](${evil})`,
      `[https://paypal](${evil})[.com/login](${evil})`,
    ]) {
      const html = md(src);
      expect(anchorTexts(html).join(""), src).not.toMatch(/^(https:\/\/)?paypal\.com(\/login)?$/);
    }
  });
});

describe("review (minor): Arabic-Indic zero beside a look-alike Arabic-Indic digit", () => {
  // Unicode's confusables list: U+0660 and U+06F0 draw as ".", U+0661 and
  // U+06F1 as "l", U+0665 as "o". Round one (536ae14) read the zero as a dot
  // wherever it stood, so all of these showed the real url. 2890ea3 read it
  // as a dot only with no Arabic-Indic digit on EITHER side, so a look-alike
  // digit next to it turned the check off again.
  const labels = [
    // "paypa", one, zero, "com": paypal.com
    "paypa\u0661\u0660com",
    // The same in the Persian forms.
    "paypa\u06f1\u06f0com",
    // Zero, five, "rg": wikipedia.org
    "wikipedia\u0660\u0665rg",
  ];
  for (const label of labels) {
    it(`does not mask ${JSON.stringify(label)}`, () => {
      expect(md(`[${label}](${evil})`)).toContain(`>${evil}</a>`);
    });
  }

  it("keeps the years masked under the both-sides rule", () => {
    for (const label of [
      "\u062a\u0642\u0631\u064a\u0631 \u0662\u0660\u0662\u0664",
      "\u06af\u0632\u0627\u0631\u0634 \u06f2\u06f0\u06f2\u06f4",
      "\u0633\u0646\u0629 \u0662\u0660\u0662\u0660",
    ]) {
      expect(md(`[${label}](https://a.bc/x)`), label).toContain('title="https://a.bc/x"');
    }
  });
});

describe("review (minor): the fallback link under a message", () => {
  it("hands MsgRender's fallback line a url whose text an override cannot reverse", () => {
    // MsgRender prints firstLinkedUrl as the text of <a href> when no
    // preview card loads; the attacker's server can make the card fail.
    // "https://" RLO "moc.lapyap@evil.example/" drew as
    // "https:///elpmaxe.live@paypal.com" there, under an honest "here".
    const url = firstLinkedUrl("[here](https://\u202emoc.lapyap@evil.example/)");
    expect(url).not.toMatch(/[\u202a-\u202e\u2066-\u2069]/);
  });
});

describe("review (minor): false positives in scripts that abbreviate with a full stop", () => {
  it("masks a Thai province abbreviation", () => {
    // "จ.เชียงใหม่" (Chiang Mai province): Thai writes no space after the
    // abbreviation's dot, and every Thai letter read as "x".
    expect(md("[\u0e08.\u0e40\u0e0a\u0e35\u0e22\u0e07\u0e43\u0e2b\u0e21\u0e48](https://a.bc/x)")).toContain(
      'title="https://a.bc/x"',
    );
  });
});
