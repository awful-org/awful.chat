import { existsSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { META } from "./page-meta";

/**
 * The invite card is built by nginx rewriting index.html for /r/*, because
 * scrapers never run JS. That coupling is invisible to every other check
 * here: a `sub_filter` whose match string is absent rewrites nothing, is not
 * an error, and logs nothing at all.
 *
 * Five of the six had named awful.frav.in, an instance the config was carried
 * over from, so they had never once fired on this one. Invite links showed
 * the right og:title over the homepage's image, url and canonical - and the
 * canonical is the one that decides it, since a crawler that honours it reads
 * the whole page as "/".
 */
const nginx = readFileSync("nginx.conf", "utf8");
const html = readFileSync("index.html", "utf8");

/** The /r/ block's match strings, in order. */
function inviteMatches(): string[] {
  const block = nginx.slice(nginx.indexOf("location ~ ^/r(/|$)"));
  const end = block.indexOf("\n    }");
  return [...block.slice(0, end).matchAll(/sub_filter\s+'((?:[^'\\]|\\.)*)'/g)].map(
    (m) => m[1]
  );
}

describe("invite card rewriting", () => {
  it("has a filter for each tag the card has to change", () => {
    expect(inviteMatches().length).toBeGreaterThanOrEqual(6);
  });

  it("matches only strings index.html actually contains", () => {
    const missing = inviteMatches().filter((m) => !html.includes(m));
    expect(missing).toEqual([]);
  });

  // The three that decide which card a scraper renders. og:title alone was
  // firing, which is exactly what made the breakage look like a cache problem.
  it("rewrites the image, the url and the canonical, not just the title", () => {
    const matches = inviteMatches();
    expect(matches.some((m) => m.includes("/og.png"))).toBe(true);
    expect(matches.some((m) => m.startsWith('content="http'))).toBe(true);
    expect(matches.some((m) => m.startsWith('href="http'))).toBe(true);
  });

  // Both halves: blocked in robots.txt, a crawler that obeys it can build no
  // card, and never sees the noindex that keeps invites out of search.
  it("lets crawlers fetch an invite's card but not index it", () => {
    expect(inviteMatches()).toContain('<meta name="robots" content="index, follow" />');
    const block = nginx.slice(nginx.indexOf("location ~ ^/r(/|$)"));
    expect(block.slice(0, block.indexOf("\n    }"))).toContain('content="noindex"');
    expect(readFileSync("public/robots.txt", "utf8")).not.toMatch(/^Disallow: \/r/m);
  });

  // $request_uri is the raw request line, and these replacements land inside
  // an HTML attribute that a scraper parses. A crafted invite link could close
  // the quote and write its own markup into the card. Nothing per-room needs
  // saying here either: the room code lives in the fragment, which the server
  // never sees.
  it("never interpolates the request line into an attribute", () => {
    const block = nginx.slice(nginx.indexOf("location ~ ^/r(/|$)"));
    const body = block.slice(0, block.indexOf("\n    }"));
    // Directives only - the comment above them names the variable it bans.
    const directives = body
      .split("\n")
      .filter((line) => !line.trim().startsWith("#"));
    expect(directives.join("\n")).not.toContain("$request_uri");
  });

  it("rewrites to the requesting host, so any instance points at itself", () => {
    const block = nginx.slice(nginx.indexOf("location ~ ^/r(/|$)"));
    const body = block.slice(0, block.indexOf("\n    }"));
    for (const line of body.split("\n")) {
      if (!line.includes("sub_filter '") || !line.includes("http")) continue;
      const replacement = [...line.matchAll(/'((?:[^'\\]|\\.)*)'/g)][1]?.[1] ?? "";
      if (replacement.includes("http")) expect(replacement).toContain("$host");
    }
  });
});

/** nginx's cards for /qs and /qc, in files of their own (nginx-cards/). */
describe.each(["qs", "qc"])("the /%s card", (path) => {
  const conf = readFileSync(`nginx-cards/${path}.conf`, "utf8");
  const filters = [...conf.matchAll(/^\s*sub_filter\s+'([^']*)'\s+'([^']*)';$/gm)].map(
    (m) => ({ match: m[1], replacement: m[2] })
  );
  const card = filters.reduce((page, f) => page.replaceAll(f.match, f.replacement), html);

  it("matches only strings index.html actually contains", () => {
    expect(filters).toHaveLength(conf.match(/^\s*sub_filter\s/gm)!.length);
    expect(filters.filter((f) => !html.includes(f.match))).toEqual([]);
  });

  it("says what page-meta.ts says", () => {
    const { title, description } = META[path];
    expect(card).toContain(`<title>${title}</title>`);
    // og:title and twitter:title.
    expect(card.split(`content="${title}"`)).toHaveLength(3);
    // The plain description, og:description and twitter:description.
    expect(card.split(`content="${description}"`)).toHaveLength(4);
  });

  it("names itself and its own picture, on whichever host", () => {
    expect(card).toContain(`href="https://$host/${path}"`);
    expect(card).toContain(`content="https://$host/${path}"`);
    expect(card.split(`https://$host/og-${path}.png`)).toHaveLength(3);
    expect(card).not.toContain("awful.chat/og.png");
    expect(existsSync(`public/og-${path}.png`)).toBe(true);
    expect(conf).not.toContain("$request_uri");
  });

  it("is included only where the page is served", () => {
    expect(nginx).toContain("include /etc/nginx/awful-cards-on/*.conf;");
    const script = readFileSync("docker-entrypoint.d/42-awful-cards.sh", "utf8");
    expect(script).toContain(`cp "$CARDS/${path}.conf" "$ON/"`);
    expect(statSync("docker-entrypoint.d/42-awful-cards.sh").mode & 0o111).not.toBe(0);
  });

  it("sends the headers the other pages send", () => {
    const headers = (text: string) => [...text.matchAll(/add_header (\S+)/g)].map((m) => m[1]);
    const block = nginx.slice(nginx.indexOf("location ~ ^/r(/|$)"));
    expect(headers(conf)).toEqual(headers(block.slice(0, block.indexOf("\n    }"))));
  });
});
