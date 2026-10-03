import { describe, expect, it } from "vitest";
import { firstLinkedUrl, linkTargets, renderMessageMarkdown, stripMarkdown, trimUrl } from "./markdown";

const names: Record<string, string> = { "did:key:zAna": "Ana" };
const md = (s: string) => renderMessageMarkdown(s, (did) => names[did] ?? did.slice(0, 8));
/** The rendered markup without its classes, which are not what is under test. */
const plain = (s: string) =>
  md(s)
    .replace(/ class="[^"]*"/g, "")
    // A fenced block's box and copy button, down to its <pre>: tested on its own below.
    .replace(/<div data-code-block><button[^]*?<\/button>(<pre)[^>]*(>[^]*?<\/pre>)<\/div>/g, "$1$2");

describe("inline markdown", () => {
  it("renders bold, italic, strikethrough and code", () => {
    expect(plain("**bold**")).toBe("<strong>bold</strong>");
    expect(plain("*italic*")).toBe("<em>italic</em>");
    expect(plain("~~gone~~")).toBe("<s>gone</s>");
    expect(plain("`x = 1`")).toBe("<code>x = 1</code>");
    expect(plain("```one line```")).toBe("<code>one line</code>");
  });

  it("nests emphasis", () => {
    expect(plain("***both***")).toBe("<em><strong>both</strong></em>");
    expect(plain("**bold *and italic***")).toBe("<strong>bold <em>and italic</em></strong>");
    expect(plain("~~**struck bold**~~")).toBe("<s><strong>struck bold</strong></s>");
    expect(plain("**a** and **b**")).toBe("<strong>a</strong> and <strong>b</strong>");
  });

  it("always nests its tags, however the markers interleave", () => {
    const awkward = ["*a **b* c**", "**a *b** c*", "~~a *b~~ c*", "***a** b*", "*a ***b* c**", "**a ~~b** c~~ d"];
    for (const input of awkward) {
      const open: string[] = [];
      for (const [, closing, tag] of md(input).matchAll(/<(\/?)(strong|em|s)>/g)) {
        if (!closing) open.push(tag);
        else expect(open.pop(), input).toBe(tag);
      }
      expect(open, input).toEqual([]);
    }
  });

  it("strikes with one tilde or two, when the pair matches", () => {
    expect(plain("~a~")).toBe("<s>a</s>");
    expect(plain("~aa~ and ~~bb~~")).toBe("<s>aa</s> and <s>bb</s>");
    expect(plain("~**both**~")).toBe("<s><strong>both</strong></s>");
    expect(plain("~a~~")).toBe("~a~~");
    expect(plain("~~a~")).toBe("~~a~");
  });

  it("leaves a lone tilde that is not a strike alone", () => {
    expect(plain("cd ~/a and ~/b")).toBe("cd ~/a and ~/b");
    expect(plain("approx ~5 min, ~10 max")).toBe("approx ~5 min, ~10 max");
    expect(plain("file~1~ and a~b~c")).toBe("file~1~ and a~b~c");
    expect(plain("~ spaced ~")).toBe("~ spaced ~");
  });

  it("leaves stray and spaced markers alone", () => {
    expect(plain("2 * 3 * 4")).toBe("2 * 3 * 4");
    expect(plain("snake*case*word")).toBe("snake*case*word");
    expect(plain("** not bold **")).toBe("** not bold **");
    expect(plain("**unclosed")).toBe("**unclosed");
    expect(plain("a ~ b ~ c")).toBe("a ~ b ~ c");
    expect(plain("~~~~a~~~~")).toBe("~~~~a~~~~");
    expect(plain("~~~a~~~")).toBe("~~~a~~~");
  });

  it("does not read markdown inside code", () => {
    expect(plain("`**not bold** [x](https://a.b)`")).toBe("<code>**not bold** [x](https://a.b)</code>");
  });

  it("takes a backslash-escaped marker literally", () => {
    expect(plain(String.raw`\*not italic\*`)).toBe("*not italic*");
    expect(plain(String.raw`\# not a heading`)).toBe("# not a heading");
    // "_" is a marker, so "\_" escapes it, as in Discord: a path that
    // must keep every backslash belongs in `code`.
    expect(plain(String.raw`C:\Users\_x`)).toBe("C:\\Users_x");
    expect(plain("`C:\\Users\\_x`")).toBe("<code>C:\\Users\\_x</code>");
  });

  it("stays linear on a run of brackets that never close", () => {
    // A label once ran on across "[", so each "[" of a peer's run of them
    // rescanned the rest of the line for a "]".
    const started = performance.now();
    for (const hostile of ["[".repeat(16384), "@[".repeat(8192), "[a".repeat(8192)]) {
      renderMessageMarkdown(hostile, (d) => d);
      stripMarkdown(hostile);
      firstLinkedUrl(hostile);
      linkTargets(hostile);
    }
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("takes the innermost brackets as a link's label", () => {
    expect(plain("[a [b](https://x.yz)")).toBe(
      '[a <a href="https://x.yz" title="https://x.yz" target="_blank" rel="noopener noreferrer">b</a>',
    );
  });

  it("masks a link, http(s) only, showing where it goes on hover", () => {
    expect(plain("[the docs](https://example.com/a)")).toBe(
      '<a href="https://example.com/a" title="https://example.com/a" target="_blank" rel="noopener noreferrer">the docs</a>',
    );
    expect(plain("[**bold** label](https://a.bc)")).toContain("><strong>bold</strong> label</a>");
    expect(plain("[x](javascript:alert(1))")).not.toContain("<a");
    expect(plain("[x](data:text/html,hi)")).not.toContain("<a");
  });

  it("will not mask a link behind a mention whose name reads as an address", () => {
    const r = (did: string) => (did === "did:key:zEve" ? "paypal.com/login" : did);
    const html = renderMessageMarkdown("[@[did:key:zEve]](https://evil.example)", r);
    expect(html).toContain(">https://evil.example</a>");
    expect(html).not.toMatch(/<a[^>]*>@paypal/);
    expect(stripMarkdown("[@[did:key:zEve]](https://evil.example)", r)).toContain("https://evil.example");
  });

  it("will not mask a link behind text that reads as another address", () => {
    const html = plain("[google.com](https://evil.example)");
    expect(html).not.toContain(">google.com</a>");
    expect(html).toContain('<a href="https://evil.example"');
    expect(html).toContain(">https://evil.example</a>");
    expect(plain("[https://bank.com](https://evil.example)")).toContain(">https://evil.example</a>");
    // Markup, trailing words or a look-alike dot around the address change nothing.
    for (const label of ["**paypal.com**", "`paypal.com`", "paypal.com login", "paypal\u2024com", "~~www.bank~~"]) {
      expect(plain(`[${label}](https://evil.example)`), label).toContain(">https://evil.example</a>");
    }
  });

  it("reads a label as it draws, so what cannot be seen does not hide an address", () => {
    const disguised = [
      // Nothing to see: zero-width characters, a soft hyphen, a joiner, a
      // variation selector, a tag character, a combining mark, and spaces
      // narrower than a word space.
      "paypal.\u200bcom",
      "paypal\u200b.com",
      "pay\u00adpal.c\u00adom",
      "paypal.\u2060com",
      "paypal.\u200ccom",
      "paypal.\ufeffcom",
      "paypal.c\u034fom",
      "paypal.co\ufe0fm",
      "paypal.\u{E0020}com",
      "paypal.c\u0337om",
      "paypal.\u200acom",
      "paypal\u2009.com",
      "paypal.\u2006com",
      "paypal\u2008.com",
      "paypal\u202f.com",
      // A letter that passes for ASCII, in the domain's last part.
      "paypal.c\u03bfm",
      "paypal.\u0441om",
      "paypal.\u0441\u043e",
      "paypal.c\u3147m",
      "paypal.c\u0d20m",
      // A digit, in a script whose letters pass for none.
      "paypal.c\u0e50m",
      "paypal.c\u0ed0m",
      "paypal.c\u17e0m",
      // A symbol that draws as a letter, beside the dot or in the last part.
      "paypa\u2223.com",
      "paypa\u05c0.com",
      "paypa\u0964.com",
      "googl\u212e.com",
      "paypal.\u2229et",
      // A dot that is not one, and letters in another form.
      "paypal\ua4f8com",
      "paypal\ufe52com",
      "paypal\u0660com",
      "paypal\uabeccom",
      "paypal\u{1ecae}com",
      // An Arabic-Indic zero beside just one digit that passes for a letter.
      "paypa\u0661\u0660com",
      "paypa\u06f1\u06f0com",
      "wikipedia\u0660\u0665rg",
      "\uff50\uff41\uff59\uff50\uff41\uff4c\uff0e\uff43\uff4f\uff4d",
      "\u{1D429}\u{1D41A}\u{1D432}\u{1D429}\u{1D41A}\u{1D425}.\u{1D41C}\u{1D428}\u{1D426}",
      // A whole url, split where it cannot be seen.
      "https:/\u200b/www\u200b.paypal\u200b.com/login",
      // Drawn backwards: an override shows "t.co" from text that spells "oc.t".
      "\u202eoc.t",
    ];
    for (const label of disguised) {
      const html = plain(`[${label}](https://evil.example/login)`);
      expect(html, label).toContain(">https://evil.example/login</a>");
      expect(html, label).not.toContain(`>${label}</a>`);
      expect(stripMarkdown(`[${label}](https://evil.example/login)`), label).toContain("https://evil.example/login");
    }
  });

  it("reads a link with the text it touches, so labels that touch cannot spell an address", () => {
    // Neither "paypal" nor ".com" is an address, but two links that touch
    // drew as one link to paypal.com, and one with the rest typed after it
    // drew the same in two colours. Every link in such a word shows its url.
    const evil = "https://evil.example/login";
    const r = (did: string) => (did === "did:key:zPay" ? "paypal" : did);
    const spelled = [
      `[paypal](${evil})[.com](${evil})`,
      `[paypal.](${evil})[com](${evil})`,
      `[pay](${evil})[pal](${evil})[.com](${evil})`,
      `[https://paypal](${evil})[.com/login](${evil})`,
      `[paypal](${evil}).com`,
      `paypal[.com](${evil})`,
      `**[paypal](${evil})**[.com](${evil})`,
      // A thin space draws as almost nothing, so it ends no word.
      `[paypal](${evil})\u2009[.com](${evil})`,
      // A mention draws as its name, in the colour of a link.
      `@[did:key:zPay][.com](${evil})`,
    ];
    for (const s of spelled) {
      expect(renderMessageMarkdown(s, r), s).not.toContain(" title=");
      expect(stripMarkdown(s, r), s).toContain(evil);
    }
  });

  it("stays linear on a line of links that touch", () => {
    // Every link is read with its word: each word is read once, not once
    // for every link in it.
    const started = performance.now();
    for (const hostile of [
      "[a](https://x.yz)".repeat(960),
      "[a.](https://x.yz)[bc](https://x.yz)".repeat(450),
      "@[did:key:zAna]".repeat(1000) + "[a](https://x.yz)",
    ]) {
      renderMessageMarkdown(hostile, (d) => d);
      stripMarkdown(hostile);
    }
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("still masks a link beside punctuation, or beside an address a space away", () => {
    const fine = [
      "[the docs](https://a.bc/x).",
      "([the docs](https://a.bc/x))",
      '"[the docs](https://a.bc/x)", then',
      "[the docs](https://a.bc/x)'s index",
      "[EN](https://a.bc/en)/[FR](https://a.bc/fr)",
      "[v1](https://a.bc/1).[2](https://a.bc/2)",
      "see example.com or [the docs](https://a.bc/x)",
      "[the docs](https://a.bc/x)\u00a0example.com",
      // A right-to-left mark a space away moves nothing in the link's word.
      "\u05e9\u05dc\u05d5\u05dd\u200f [the docs](https://a.bc/x)",
    ];
    for (const s of fine) {
      expect(plain(s), s).not.toContain("](");
    }
  });

  it("keeps a masked link in the line's own text, where right-to-left text cannot move it", () => {
    // An isolate is laid out as one piece, and between two Hebrew words, or
    // two invisible right-to-left marks, "[.com](…)[paypal](…)" drew as one
    // link to paypal.com. A masked link is text of the line, whose letters
    // stay where they are typed.
    const evil = "https://evil.example/login";
    const html = md(`\u05e9\u05dc\u05d5\u05dd [.com](${evil})[paypal](${evil}) \u05e2\u05d5\u05dc\u05dd`);
    expect(html.match(/<a [^>]*>/g)).toHaveLength(2);
    expect(html).not.toContain("dir=");
    // What can still move what is typed shows every url: a right-to-left
    // mark in the word (between two, "w.3org" draws as "w3.org"), or an
    // override, embedding or isolate anywhere in the line, code included.
    const moved = [
      `\u200f[.com](${evil})[paypal](${evil})\u200f`,
      `\u061c.[paypal](${evil})\u061ccom`,
      `[w\u200f.3\u200forg](${evil})`,
      `[w](${evil})\u200f.3\u200forg`,
      `\u202e x [.com](${evil})[paypal](${evil})`,
      `\u2067x\u2069 [the docs](${evil})`,
      `\`\u202e\` [the docs](${evil})`,
    ];
    for (const s of moved) {
      expect(md(s), s).not.toContain(" title=");
    }
  });

  it("still masks a label in any language that is not an address", () => {
    const labels = [
      "Instala\u00e7\u00e3o do servidor",
      "caf\u00e9 com leite",
      "H\u01b0\u1edbng d\u1eabn s\u1eed d\u1ee5ng",
      "col\u00b7lecci\u00f3",
      "\u041c\u043e\u0441\u043a\u0432\u0430",
      "\u65e5\u672c\u8a9e\u306e\u30da\u30fc\u30b8\u3002\u8a73\u3057\u304f\u306f\u3053\u3061\u3089",
      "iPhone\u306e\u4f7f\u3044\u65b9\u3002\u8a73\u3057\u304f",
      // Japanese's long vowel mark before a full stop, then Latin letters.
      "\u30b5\u30fc\u30d0\u30fc\u3002iOS\u7248\u3082",
      // A year in Arabic-Indic digits, whose zero is drawn as a dot.
      "\u062a\u0642\u0631\u064a\u0631 \u0662\u0660\u0662\u0664",
      "\u06af\u0632\u0627\u0631\u0634 \u06f2\u06f0\u06f2\u06f4",
      "\u0633\u0646\u0629 \u0662\u0660\u0662\u0660",
      // Meetei Mayek's heavy tone mark, on a Meetei syllable.
      "\uabc3\uabe4\uabc7\uabe9\uabec\uabc2\uabe3\uabdf",
      "\ud83d\udc68\u200d\ud83d\udc69\u200d\ud83d\udc67 photos",
      // A full stop inside a word, in scripts whose letters pass for no ASCII one.
      "\u0e08.\u0e40\u0e0a\u0e35\u0e22\u0e07\u0e43\u0e2b\u0e21\u0e48",
      "\u0e1e.\u0e28.\u0e52\u0e55\u0e56\u0e57",
      "\u0eaa.\u0e9b.\u0e9b.\u0ea5\u0eb2\u0ea7",
      "\u1796.\u179f.\u17e2\u17e5\u17e6\u17e7",
      "\u0bae\u0bc1.\u0b95\u0bb0\u0bc1\u0ba3\u0bbe\u0ba8\u0bbf\u0ba4\u0bbf",
      "\u0921\u0949.\u0930\u093e\u092e",
      "\u09a1\u09be.\u09b0\u09b9\u09ae\u09be\u09a8",
      "e.g. this one",
      "v1.2 notes",
    ];
    for (const label of labels) {
      expect(plain(`[${label}](https://a.bc/x)`), label).toContain(`title="https://a.bc/x"`);
    }
  });

  it("keeps a link's text in its own order, whatever is typed around or inside it", () => {
    // An override typed before a link and closed after it reversed the text
    // inside: a masked "oc.t" drew as "t.co", and a bare url as another
    // host's. A url shown is an isolate, left to right, which nothing
    // outside reaches and a right-to-left mark inside cannot turn around,
    // and a line holding an override, embedding or isolate masks no link.
    const outside = [
      "\u202e[oc.t](https://evil.example/login)\u202c",
      "\u202e see https://evil.example/moc.lapyap//:sptth \u202c",
      "\u202b[\u200fco\u200f.\u200ft](https://evil.example/login)\u202c",
      "\u2067[paypal.com](https://evil.example/login)\u2069",
    ];
    for (const s of outside) {
      const tags = [...md(s).matchAll(/<a [^>]*>/g)].map((m) => m[0]);
      expect(tags, s).toHaveLength(1);
      expect(tags[0], s).toContain(' dir="ltr"');
      expect(tags[0], s).not.toContain(" title=");
    }
    // One inside a url, where the url is shown: "https://" then an override
    // then "moc.lapyap@evil.example" drew as a link to paypal.com.
    const inside = "https://\u202emoc.lapyap@evil.example/";
    const shown = "https://moc.lapyap@evil.example/";
    expect(md(inside)).toContain(`>${shown}</a>`);
    expect(md(`[paypal.com](${inside})`)).toContain(`>${shown}</a>`);
    expect(md(`[the docs](${inside})`)).toContain(` title="${shown}"`);
    // Where it goes is left alone: the browser encodes the override.
    expect(md(inside)).toContain(`href="${inside}"`);
  });

  it("links bare urls without the punctuation around them", () => {
    expect(plain("see https://a.bc/d.")).toBe(
      'see <a href="https://a.bc/d" target="_blank" rel="noopener noreferrer" dir="ltr">https://a.bc/d</a>.',
    );
    expect(plain("(https://a.bc)")).toContain(">https://a.bc</a>)");
    expect(plain("https://en.wikipedia.org/wiki/Foo_(bar)")).toContain(">https://en.wikipedia.org/wiki/Foo_(bar)</a>");
    expect(plain("**https://a.bc**")).toBe(
      '<strong><a href="https://a.bc" target="_blank" rel="noopener noreferrer" dir="ltr">https://a.bc</a></strong>',
    );
  });

  it("never puts emphasis inside a url, and emphasizes one wrapped in markers", () => {
    expect(plain("https://a.bc/*x*/~~y~~/z")).toBe(
      '<a href="https://a.bc/*x*/~~y~~/z" target="_blank" rel="noopener noreferrer" dir="ltr">https://a.bc/*x*/~~y~~/z</a>',
    );
    expect(plain("~~https://a.bc~~")).toBe(
      '<s><a href="https://a.bc" target="_blank" rel="noopener noreferrer" dir="ltr">https://a.bc</a></s>',
    );
  });

  it("shows mentions by name, as text inside code", () => {
    expect(md("hi @[did:key:zAna]")).toBe('hi <span class="font-medium text-primary">@Ana</span>');
    expect(plain("`@[did:key:zAna]`")).toBe("<code>@Ana</code>");
  });

  it("wraps emoji outside code only", () => {
    expect(md("ok 👍")).toBe('ok <span class="emoji">👍</span>');
    expect(plain("`👍`")).toBe("<code>👍</code>");
  });
});

describe("block markdown", () => {
  it("renders headings one to three", () => {
    expect(plain("# One")).toBe("<h1>One</h1>");
    expect(plain("## Two")).toBe("<h2>Two</h2>");
    expect(plain("### Three")).toBe("<h3>Three</h3>");
    expect(plain("#### Four")).toBe("#### Four");
    expect(plain("#hashtag")).toBe("#hashtag");
  });

  it("groups list items", () => {
    expect(plain("- a\n- **b**\n* c")).toBe("<ul><li>a</li><li><strong>b</strong></li><li>c</li></ul>");
    expect(plain("-5 degrees")).toBe("-5 degrees");
  });

  it("keeps plain newlines and drops the one a block already breaks", () => {
    expect(plain("one\ntwo")).toBe("one\ntwo");
    expect(plain("# Title\nbody")).toBe("<h1>Title</h1>body");
    expect(plain("intro\n- a\n- b\noutro")).toBe("intro<ul><li>a</li><li>b</li></ul>outro");
  });

  it("keeps a blank line beside a block as a gap, one per blank line", () => {
    const gap = "<div><br></div>";
    expect(plain("# Title\n\nbody")).toBe(`<h1>Title</h1>${gap}body`);
    expect(plain("para\n\n- a")).toBe(`para${gap}<ul><li>a</li></ul>`);
    expect(plain("- a\n\n- b")).toBe(`<ul><li>a</li></ul>${gap}<ul><li>b</li></ul>`);
    expect(plain("- a\n\n\n- b")).toBe(`<ul><li>a</li></ul>${gap}${gap}<ul><li>b</li></ul>`);
    expect(plain("```\nx\n```\n\nafter")).toBe(`<pre><code>x</code></pre>${gap}after`);
    expect(plain("# Title\n  \nbody")).toBe(`<h1>Title</h1>${gap}body`);
    expect(plain("# Title\r\n\r\nbody")).toBe(`<h1>Title</h1>${gap}body`);
  });

  it("leaves blank lines between plain lines to the newlines, as before", () => {
    expect(plain("one\n\ntwo")).toBe("one\n\ntwo");
  });

  it("renders a fenced block verbatim, and an unclosed fence as text", () => {
    expect(plain("before\n```py\n# not a heading\n- not a list\n```\nafter")).toBe(
      "before<pre><code># not a heading\n- not a list</code></pre>after",
    );
    expect(plain("```\n**x**")).toBe("```\n<strong>x</strong>");
  });

  it("renders the example from the request", () => {
    const html = plain(
      "**bold**\n*italic*\n~~strikethrough~~\n`inline code`\n# Heading\n- list item\n[link](https://example.com)",
    );
    expect(html).toBe(
      "<strong>bold</strong>\n<em>italic</em>\n<s>strikethrough</s>\n<code>inline code</code>" +
        "<h1>Heading</h1><ul><li>list item</li></ul>" +
        '<a href="https://example.com" title="https://example.com" target="_blank" rel="noopener noreferrer">link</a>',
    );
  });
});

describe("safety", () => {
  const payloads = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "**<img src=x onerror=alert(1)>**",
    "`<img src=x onerror=alert(1)>`",
    "# <img src=x onerror=alert(1)>",
    "- <img src=x onerror=alert(1)>",
    "[<img src=x onerror=alert(1)>](https://a.bc)",
    '[x](https://a.bc/"onmouseover="alert(1))',
    'https://a.bc/"onmouseover="alert(1)',
    "```\n<script>alert(1)</script>\n```",
  ];

  it("escapes every tag a message carries", () => {
    for (const p of payloads) {
      const html = md(p);
      expect(html, p).not.toMatch(/<(script|img)/i);
      // An event attribute inside a real tag; escaped text may say "onerror".
      expect(html, p).not.toMatch(/<[^>]*\son\w+=/i);
    }
  });

  it("does not let a message forge a placeholder, nor give up a character to them", () => {
    expect(plain("<0> and `x`")).toBe("&lt;0&gt; and <code>x</code>");
    expect(plain("\uE0000\uE001 and `x`")).toBe("\uE0000\uE001 and <code>x</code>");
  });

  it("renders nothing for content that is not a string", () => {
    expect(renderMessageMarkdown(42 as unknown as string, () => "")).toBe("");
  });
});

describe("trimUrl", () => {
  it("drops trailing punctuation and an unopened parenthesis", () => {
    expect(trimUrl("https://a.bc/d.")).toEqual({ url: "https://a.bc/d", rest: "." });
    expect(trimUrl("https://a.bc)")).toEqual({ url: "https://a.bc", rest: ")" });
    expect(trimUrl("https://a.bc/x_(y)")).toEqual({ url: "https://a.bc/x_(y)", rest: "" });
    expect(trimUrl("https://a.bc/?q=1!")).toEqual({ url: "https://a.bc/?q=1", rest: "!" });
  });

  it("keeps the parentheses the url opened, however many follow it", () => {
    expect(trimUrl("https://a.bc/x_(y)))")).toEqual({ url: "https://a.bc/x_(y)", rest: "))" });
    expect(trimUrl("https://a.bc/((x)))")).toEqual({ url: "https://a.bc/((x))", rest: ")" });
    expect(trimUrl("https://a.bc/(x)).)")).toEqual({ url: "https://a.bc/(x)", rest: ").)" });
  });

  it("stays linear on a url a peer follows with thousands of parentheses", () => {
    // Recounting the url's parentheses for every ")" it dropped was
    // quadratic: one message of a url and 16k of them held every render of
    // it, and every notification and preview, for seconds.
    const hostile = "https://a.b/" + ")".repeat(16372);
    const started = performance.now();
    expect(trimUrl(hostile)).toEqual({ url: "https://a.b/", rest: ")".repeat(16372) });
    expect(firstLinkedUrl(hostile)).toBe("https://a.b/");
    renderMessageMarkdown(hostile, (d) => d);
    stripMarkdown(hostile);
    linkTargets(hostile);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("firstLinkedUrl", () => {
  it("is the first url the body renders as a link", () => {
    expect(firstLinkedUrl("see https://a.bc/d.")).toBe("https://a.bc/d");
    expect(firstLinkedUrl("(https://a.bc)")).toBe("https://a.bc");
    expect(firstLinkedUrl("[docs](https://a.bc/x) and https://z.yx")).toBe("https://a.bc/x");
    expect(firstLinkedUrl("[https://good.com](https://evil.example)")).toBe("https://evil.example");
  });

  it("gives a url's bidi controls percent-encoded, as the browser sends them", () => {
    // MsgRender prints it under the message when no preview loads: "https://"
    // with an override and "moc.lapyap@evil.example" after it drew there as a
    // link to paypal.com, under an honest "here".
    expect(firstLinkedUrl("[here](https://\u202emoc.lapyap@evil.example/)")).toBe(
      "https://%E2%80%AEmoc.lapyap@evil.example/",
    );
    expect(firstLinkedUrl("see https://a.bc/\u2067x\u2069.")).toBe("https://a.bc/%E2%81%A7x%E2%81%A9");
    // It goes where it went.
    expect(new URL("https://a.bc/%E2%81%A7x").href).toBe(new URL("https://a.bc/\u2067x").href);
  });

  it("skips a url written as code", () => {
    expect(firstLinkedUrl("`https://internal.example` then https://a.bc")).toBe("https://a.bc");
    expect(firstLinkedUrl("```\ncurl https://internal.example\n```")).toBeNull();
    expect(firstLinkedUrl(42 as unknown as string)).toBeNull();
  });
});

describe("stripMarkdown", () => {
  it("drops markup and keeps the words", () => {
    expect(stripMarkdown("**bold** *italic* ~~gone~~ `code`")).toBe("bold italic gone code");
    expect(stripMarkdown("# Heading\n- one\n* two")).toBe("Heading\n• one\n• two");
    expect(stripMarkdown("[the docs](https://a.bc/x) and https://a.bc/y.")).toBe("the docs and https://a.bc/y.");
    expect(stripMarkdown(String.raw`\*literal\*`)).toBe("*literal*");
  });

  it("keeps code, and a fence's contents, exactly as written", () => {
    expect(stripMarkdown("`**not bold**`")).toBe("**not bold**");
    expect(stripMarkdown("```py\n# comment\n- dash\n```")).toBe("# comment\n- dash");
  });

  it("leaves text that only looks like markup alone", () => {
    expect(stripMarkdown("2 * 3 * 4 and snake*case*word")).toBe("2 * 3 * 4 and snake*case*word");
    expect(stripMarkdown("a < b && c > d, \"quoted\" 'too'")).toBe("a < b && c > d, \"quoted\" 'too'");
  });

  it("keeps a look-alike link whole, so the text does not claim the wrong site", () => {
    expect(stripMarkdown("[paypal.com](https://evil.example)")).toBe("[paypal.com](https://evil.example)");
  });

  it("names real mentions itself, and never one the sender escaped", () => {
    const r = (did: string) => names[did] ?? did;
    expect(stripMarkdown("**hi** @[did:key:zAna]", r)).toBe("hi @Ana");
    expect(stripMarkdown("`@[did:key:zAna]`", r)).toBe("@Ana");
    // Shown as literal text in the message, so literal in the notification.
    expect(stripMarkdown(String.raw`@\[did:key:zAna\]`, r)).toBe("@[did:key:zAna]");
    expect(stripMarkdown("@*[did:key:zAna]*", r)).toBe("@[did:key:zAna]");
  });

  it("keeps mention tokens as written without a resolver, for the search index", () => {
    expect(stripMarkdown("**hi** @[did:key:zAna]")).toBe("hi @[did:key:zAna]");
  });

  it("returns nothing for content that is not a string", () => {
    expect(stripMarkdown(7 as unknown as string)).toBe("");
  });
});

describe("emphasis at scale", () => {
  it("stays linear on interleaved markers a peer could send", () => {
    const hostile = "*a ".repeat(4000) + "a~~ ".repeat(4000);
    const started = performance.now();
    stripMarkdown(hostile);
    renderMessageMarkdown(hostile, (d) => d);
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe("fenced blocks", () => {
  it("gives every block its language and a copy button, not only the first", () => {
    const html = md("```js\nlet a = 1\n```\nand\n```py\nb = 2\n```");
    expect(html.match(/data-copy-code/g)).toHaveLength(2);
    expect(html).toContain('data-lang="js"><code>let a = 1</code>');
    expect(html).toContain('data-lang="py"><code>b = 2</code>');
    expect(md("```\nplain\n```")).toContain('data-lang="text"');
  });

  it("closes on \"``` done\", the words after it following the block", () => {
    expect(plain("```\ncode\n``` done")).toBe("<pre><code>code</code></pre>done");
    // A fence written out inside code does not close it.
    expect(plain("```md\n```js\nx\n```")).toBe("<pre><code>```js\nx</code></pre>");
  });

  it("keeps the loose fences chat has always accepted", () => {
    expect(plain("look: ```js\nx()\n```")).toBe("look:<pre><code>x()</code></pre>");
    expect(plain("```\nif (a) {\n}```")).toBe("<pre><code>if (a) {\n}</code></pre>");
  });

  it("stays linear on a message of openers that never close", () => {
    const started = performance.now();
    md("```a\n".repeat(13000));
    stripMarkdown("```a\n".repeat(13000));
    expect(performance.now() - started).toBeLessThan(500);
  });

  it("escapes a language that is not one", () => {
    expect(md('```"><img src=x onerror=alert(1)>\nx\n```')).not.toMatch(/<img/);
  });
});

describe("discord-style inline markup", () => {
  it("italicizes with underscores and underlines with two, leaving snake_case alone", () => {
    expect(plain("_italic_")).toBe("<em>italic</em>");
    expect(plain("__underline__")).toBe("<u>underline</u>");
    expect(plain("___both___")).toBe("<em><u>both</u></em>");
    expect(plain("__*mixed*__")).toBe("<u><em>mixed</em></u>");
    expect(plain("snake_case_name and __init__.py")).toBe("snake_case_name and <u>init</u>.py");
    expect(plain("a_b_c")).toBe("a_b_c");
    expect(plain(String.raw`\_not italic\_`)).toBe("_not italic_");
  });

  it("hides a spoiler until revealed, and never names it in plain text", () => {
    const html = md("the killer is ||the butler||");
    expect(html).toContain('data-spoiler role="button" tabindex="0"');
    expect(html).toMatch(/<span[^>]*data-spoiler[^>]*>the butler<\/span>$/);
    expect(stripMarkdown("the killer is ||the butler||")).toBe("the killer is [spoiler]");
    expect(stripMarkdown("||**bold** secret|| and ||two||")).toBe("[spoiler] and [spoiler]");
  });

  it("takes a spoiler around a link, and a lone bar as a bar", () => {
    expect(md("||https://a.bc||")).toMatch(/data-spoiler[^>]*><a href="https:\/\/a\.bc"/);
    expect(plain("a | b | c")).toBe("a | b | c");
    expect(plain("|||x|||")).toBe("|||x|||");
    expect(plain("||unclosed")).toBe("||unclosed");
  });
});

describe("discord-style blocks", () => {
  it("quotes a line, and a run of lines as one quote", () => {
    expect(plain("> hello")).toBe("<blockquote>hello</blockquote>");
    expect(plain("> one\n> **two**\nafter")).toBe("<blockquote>one\n<strong>two</strong></blockquote>after");
    expect(plain(">_<")).toBe("&gt;_&lt;");
  });

  it("quotes the rest of the message after >>>", () => {
    expect(plain("before\n>>> all\nof\n- this")).toBe(
      "before<blockquote>all\nof<ul><li>this</li></ul></blockquote>",
    );
  });

  it("does not nest quotes", () => {
    expect(plain("> > inner")).toBe("<blockquote>&gt; inner</blockquote>");
  });

  it("numbers lists, starting where the first item says", () => {
    expect(plain("1. one\n2. two")).toBe("<ol><li>one</li><li>two</li></ol>");
    expect(plain("3. three\n4. four")).toBe('<ol start="3"><li>three</li><li>four</li></ol>');
    expect(plain("1) paren")).toBe("<ol><li>paren</li></ol>");
  });

  it("nests lists by indentation, bullets and numbers mixed", () => {
    expect(plain("- a\n  - b\n    1. c\n- d")).toBe(
      "<ul><li>a<ul><li>b<ol><li>c</li></ol></li></ul></li><li>d</li></ul>",
    );
    // A jump of two levels goes one deeper, never more.
    expect(plain("- a\n      - b")).toBe("<ul><li>a<ul><li>b</li></ul></li></ul>");
    // Bullets then numbers at the same depth are two lists.
    expect(plain("- a\n1. b")).toBe("<ul><li>a</li></ul><ol><li>b</li></ol>");
    // Siblings typed at the same indent stay siblings, however far in.
    expect(plain("- a\n    - b\n    - c\n- d")).toBe(
      "<ul><li>a<ul><li>b</li><li>c</li></ul></li><li>d</li></ul>",
    );
    expect(stripMarkdown("- a\n    - b\n    - c")).toBe("• a\n  • b\n  • c");
  });

  it("quotes a fence the quote opens with, and leaves a bare > as text", () => {
    expect(plain("> ```js\n> x = 1\n> ```")).toBe('<blockquote><pre><code>x = 1</code></pre></blockquote>');
    expect(plain(">>> ```\nx\n```")).toBe('<blockquote><pre><code>x</code></pre></blockquote>');
    expect(plain(">")).toBe("&gt;");
    expect(plain(">>>")).toBe("&gt;&gt;&gt;");
    expect(plain(">\n>")).toBe("&gt;\n&gt;");
  });

  it("renders -# as subtext", () => {
    expect(plain("-# small print")).toBe("<div>small print</div>");
    expect(plain("-#nope")).toBe("-#nope");
  });

  it("strips the new blocks to plain text", () => {
    expect(stripMarkdown("> quoted _it_\n1. first\n  - sub\n-# fine print")).toBe(
      "quoted it\n1. first\n  • sub\nfine print",
    );
  });

  it("never previews or indexes a link a spoiler hides", () => {
    expect(firstLinkedUrl("||[a](https://secret.example)|| and https://open.example")).toBe("https://open.example");
    expect(firstLinkedUrl("||https://secret.example||")).toBeNull();
    expect(linkTargets("||[a](https://secret.example)|| [b](https://open.example)")).toEqual(["https://open.example"]);
    // Bars found where the renderer finds them: after an escaped bar, not in code.
    expect(firstLinkedUrl(String.raw`\|||a https://secret.example||`)).toBeNull();
    expect(firstLinkedUrl("`||` https://open.example `||`")).toBe("https://open.example");
  });

  it("finds links inside a quote for the preview", () => {
    expect(firstLinkedUrl("> see [this](https://a.bc)")).toBe("https://a.bc");
  });
});
