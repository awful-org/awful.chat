/**
 * Reading a text or markdown attachment without downloading it first.
 *
 * Both halves are lazy: marked and DOMPurify are a few tens of KB that
 * nobody needs until they open a .md, and shiki is already lazy for the same
 * reason in chat code blocks.
 */

import { canLoadMedia } from "./media-prefs.svelte";

/**
 * Every language shiki bundles, by id and alias.
 *
 * Generated from shiki's own bundledLanguagesInfo rather than picked by
 * hand: a curated list is somebody's guess at what people send, and it was
 * already wrong for .vue, .svelte and .zig. If shiki can highlight it, it is
 * text and it is worth opening. Kept as data here rather than read at
 * runtime because the decision runs while a message renders and has to be
 * synchronous - the language chunks themselves stay lazy, as they are for
 * chat code blocks.
 *
 * Most of these double as file extensions. The ones that do not (an alias
 * like "c#") simply never match an extension, which costs nothing.
 */
const SHIKI_EXTENSIONS = new Set([
  "1c", "1c-query", "abap", "actionscript-3", "ada", "adoc",
  "angular-html", "angular-ts", "apache", "apex", "apl", "applescript",
  "ara", "asciidoc", "asm", "astro", "awk", "ballerina", "bash", "bat",
  "batch", "be", "beancount", "berry", "bibtex", "bicep", "bird", "bird2",
  "blade", "bsl", "c", "c#", "c++", "c3", "cadence", "cairo", "cdc", "cjs",
  "clarity", "clj", "clojure", "closure-templates", "cmake", "cmd",
  "cobol", "codeowners", "codeql", "coffee", "coffeescript", "common-lisp",
  "console", "coq", "cpp", "cql", "crystal", "cs", "csharp", "css", "csv",
  "cts", "cue", "cypher", "d", "dart", "dax", "desktop", "diff", "docker",
  "dockerfile", "dotenv", "dream-maker", "edge", "elisp", "elixir", "elm",
  "emacs-lisp", "erb", "erl", "erlang", "f", "f#", "f03", "f08", "f18",
  "f77", "f90", "f95", "fennel", "fish", "fluent", "for",
  "fortran-fixed-form", "fortran-free-form", "fs", "fsharp", "fsl", "ftl",
  "gd", "gdresource", "gdscript", "gdshader", "genie", "gherkin",
  "git-commit", "git-rebase", "gjs", "gleam", "glimmer-js", "glimmer-ts",
  "glsl", "gn", "gnuplot", "go", "gql", "graphql", "groovy", "gts", "hack",
  "haml", "handlebars", "haskell", "haxe", "hbs", "hcl", "hjson", "hlsl",
  "hs", "html", "html-derivative", "http", "hurl", "hxml", "hy", "imba",
  "ini", "jade", "java", "javascript", "jinja", "jison", "jl", "js",
  "json", "json5", "jsonc", "jsonl", "jsonnet", "jssm", "jsx", "julia",
  "just", "kdl", "kotlin", "kql", "kt", "kts", "kusto", "latex", "lean",
  "lean4", "less", "liquid", "lisp", "lit", "llvm", "log", "logo", "lua",
  "luau", "make", "makefile", "markdown", "marko", "matlab", "mbt", "mbti",
  "md", "mdc", "mdx", "mediawiki", "mermaid", "mips", "mipsasm", "mjs",
  "mmd", "mojo", "moonbit", "move", "mts", "nar", "narrat", "nextflow",
  "nextflow-groovy", "nf", "nginx", "nim", "nix", "nu", "nushell", "objc",
  "objective-c", "objective-cpp", "ocaml", "odin", "openscad", "pascal",
  "perl", "perl6", "php", "pkl", "plsql", "po", "polar", "postcss", "pot",
  "potx", "powerquery", "powershell", "prisma", "prolog", "properties",
  "proto", "protobuf", "ps", "ps1", "pug", "puppet", "purescript", "py",
  "python", "ql", "qml", "qmldir", "qss", "r", "racket", "raku", "razor",
  "rb", "reg", "regex", "regexp", "rel", "riscv", "ron", "rosmsg", "rs",
  "rst", "ruby", "rust", "sas", "sass", "scad", "scala", "scheme", "scss",
  "sdbl", "sh", "shader", "shaderlab", "shell", "shellscript",
  "shellsession", "smalltalk", "solidity", "soy", "sparql", "spl",
  "splunk", "sql", "ssh-config", "stata", "styl", "stylus", "surql",
  "surrealql", "svelte", "swift", "system-verilog", "systemd", "talon",
  "talonscript", "tasl", "tcl", "templ", "terraform", "tex", "tf",
  "tfvars", "toml", "tres", "ts", "ts-tags", "tscn", "tsp", "tsv", "tsx",
  "turtle", "twig", "typ", "typescript", "typespec", "typst", "v", "vala",
  "vb", "verilog", "vhdl", "vim", "viml", "vimscript", "vue", "vue-html",
  "vue-vine", "vy", "vyper", "wasm", "wenyan", "wgsl", "wiki", "wikitext",
  "wit", "wl", "wolfram", "xml", "xsl", "yaml", "yml", "zenscript", "zig",
  "zsh", "文言"
]);

/**
 * Text that is not a language, plus the few extensions shiki knows under
 * another name.
 */
const PLAIN_TEXT_EXTENSIONS = [
  "txt", "text", "log", "conf", "cfg", "env", "lock", "properties",
  "gitignore", "gitattributes", "editorconfig", "npmrc", "nvmrc",
  "dockerignore", "h", "hh", "hxx", "mjs", "mts", "cts", "readme", "license",
  "notes", "srt", "vtt", "ics", "po", "pot",
];

const MARKDOWN_EXTENSIONS = ["md", "mdx", "markdown"];

/** Refuse to read a whole disk image into a string. */
export const MAX_PREVIEW_BYTES = 2 * 1024 * 1024;

export function extensionOf(filename: string): string {
  const m = /\.([^./\\]+)$/.exec(filename);
  return m ? m[1].toLowerCase() : filename.toLowerCase();
}

export type PreviewKind = "markdown" | "text" | null;

/**
 * What, if anything, this attachment should open as.
 *
 * Extension first and mime type second, because a plain .md arrives as
 * text/plain or application/octet-stream far more often than as text/markdown
 * - browsers guess the type from the same extension we are looking at, and
 * guess it badly.
 */
export function previewKind(
  filename: string,
  mimeType: string,
  size: number
): PreviewKind {
  if (size > MAX_PREVIEW_BYTES) return null;
  const ext = extensionOf(filename);
  if (MARKDOWN_EXTENSIONS.includes(ext)) return "markdown";
  if (SHIKI_EXTENSIONS.has(ext) || PLAIN_TEXT_EXTENSIONS.includes(ext))
    return "text";
  // A mime type that says text but an extension we do not know: still text.
  if (mimeType.startsWith("text/")) return "text";
  return null;
}

/**
 * Markdown to HTML, sanitized.
 *
 * The input is a file another person sent, so the output of marked is
 * attacker-shaped by definition and goes nowhere near innerHTML until
 * DOMPurify has been over it. Both are imported here rather than at module
 * scope so the cost lands on whoever opens a markdown file.
 */
export async function renderMarkdown(source: string): Promise<string> {
  const [{ marked }, purifyMod] = await Promise.all([
    import("marked"),
    import("dompurify"),
  ]);
  const DOMPurify = purifyMod.default;
  // target="_blank" without rel hands the opened page a window.opener back
  // to this one. DOMPurify strips attributes it was not told about, so this
  // has to run after sanitizing rather than inside the markdown.
  DOMPurify.addHook("afterSanitizeAttributes", (node) => {
    if (node.tagName === "A") {
      node.setAttribute("target", "_blank");
      node.setAttribute("rel", "noopener noreferrer");
    }
    // A peer's .md file must not load what the rest of the app would not:
    // a remote image here was a tracking pixel that ignored the external
    // media switch. srcset can name remote URLs too, so it goes.
    node.removeAttribute("srcset");
    for (const attr of ["src", "poster"]) {
      const value = node.getAttribute(attr);
      if (value !== null && !canLoadMedia(value)) node.removeAttribute(attr);
    }
  });
  try {
    return await sanitizedMarkdown(marked, DOMPurify, source);
  } finally {
    // Hooks are global to the DOMPurify instance. Without the finally, a
    // malformed .md from a peer that made marked or sanitize throw would
    // leave this installed for every later sanitize call in the app.
    DOMPurify.removeHook("afterSanitizeAttributes");
  }
}

async function sanitizedMarkdown(
  marked: { parse: (s: string, o: object) => string | Promise<string> },
  DOMPurify: { sanitize: (html: string, cfg: object) => string },
  source: string
): Promise<string> {
  const html = await marked.parse(source, { gfm: true, breaks: false });
  return DOMPurify.sanitize(html, {
    // Links open in a new tab, so target is allowed - and every anchor gets
    // rel="noopener noreferrer" added below, since target="_blank" without it
    // hands the opened page a reference back to this one.
    ADD_ATTR: ["target"],
    // No <form>: a sanitized form is still a form, and a markdown file has
    // no business asking for input.
    FORBID_TAGS: ["form", "input", "button", "style"],
    // No inline styles either: they allowed a full-screen fixed overlay over
    // the app, the start of any phishing page.
    FORBID_ATTR: ["style"],
  });
}

/**
 * The shiki language for an extension, or null when it is text with no
 * grammar behind it (a .log, a .env) and should render plain.
 */
export function highlightLanguage(filename: string): string | null {
  const ext = extensionOf(filename);
  return SHIKI_EXTENSIONS.has(ext) ? ext : null;
}

/**
 * Highlight source for the viewer.
 *
 * Returns null when shiki has no grammar, cannot load one, or the theme is
 * unavailable - every one of which is a reason to fall back to a plain <pre>
 * rather than to show nothing.
 */
export async function highlightText(
  source: string,
  lang: string
): Promise<string | null> {
  try {
    const { codeToHtml } = await import("shiki");
    // github-dark, the same theme chat code blocks use. A second theme here
    // would need the dual-CSS-variable output and its own stylesheet, for a
    // panel that already sits on the app's own surface.
    return await codeToHtml(source, { lang, theme: "github-dark" });
  } catch {
    return null;
  }
}
