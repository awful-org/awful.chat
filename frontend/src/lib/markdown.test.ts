import { describe, expect, it } from "vitest";
import { firstLinkedUrl, renderMessageMarkdown, stripMarkdown, trimUrl } from "./markdown";

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
    // "_" is no marker here, so a path keeps its backslash.
    expect(plain(String.raw`C:\Users\_x`)).toBe(String.raw`C:\Users\_x`);
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

  it("links bare urls without the punctuation around them", () => {
    expect(plain("see https://a.bc/d.")).toBe(
      'see <a href="https://a.bc/d" target="_blank" rel="noopener noreferrer">https://a.bc/d</a>.',
    );
    expect(plain("(https://a.bc)")).toContain(">https://a.bc</a>)");
    expect(plain("https://en.wikipedia.org/wiki/Foo_(bar)")).toContain(">https://en.wikipedia.org/wiki/Foo_(bar)</a>");
    expect(plain("**https://a.bc**")).toBe(
      '<strong><a href="https://a.bc" target="_blank" rel="noopener noreferrer">https://a.bc</a></strong>',
    );
  });

  it("never puts emphasis inside a url, and emphasizes one wrapped in markers", () => {
    expect(plain("https://a.bc/*x*/~~y~~/z")).toBe(
      '<a href="https://a.bc/*x*/~~y~~/z" target="_blank" rel="noopener noreferrer">https://a.bc/*x*/~~y~~/z</a>',
    );
    expect(plain("~~https://a.bc~~")).toBe(
      '<s><a href="https://a.bc" target="_blank" rel="noopener noreferrer">https://a.bc</a></s>',
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
});

describe("firstLinkedUrl", () => {
  it("is the first url the body renders as a link", () => {
    expect(firstLinkedUrl("see https://a.bc/d.")).toBe("https://a.bc/d");
    expect(firstLinkedUrl("(https://a.bc)")).toBe("https://a.bc");
    expect(firstLinkedUrl("[docs](https://a.bc/x) and https://z.yx")).toBe("https://a.bc/x");
    expect(firstLinkedUrl("[https://good.com](https://evil.example)")).toBe("https://evil.example");
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
