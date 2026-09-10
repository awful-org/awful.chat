/**
 * Per-route title, description and canonical.
 *
 * index.html carries one static set for the landing page, including
 * `<link rel="canonical" href="https://awful.chat">`. That single canonical is
 * doing real work: nginx answers every unknown path with the app shell at 200,
 * so without it the whole URL space would be duplicate content. It also means
 * every route declares itself a copy of the root - fine for /app and /r/,
 * which are behind robots.txt and have nothing to index anyway.
 *
 * /qs and /qc are the exception. They are the two pages somebody might arrive
 * at from a search ("send a large file without uploading it", "video call with
 * no account"), and a page that canonicalises to the root can never answer
 * one. So they say who they are instead.
 *
 * Origin-relative on purpose, unlike the static tag: a self-hosted instance
 * that turns these on gets a canonical naming itself rather than awful.chat.
 */

interface RouteMeta {
  title: string;
  description: string;
  /** Path to self-canonicalise to, or null to leave the static tag alone. */
  path: string | null;
}

const META: Record<string, RouteMeta> = {
  qs: {
    title: "Send a file with no account - Awful.chat",
    description:
      "Send a file straight to someone over an encrypted peer-to-peer connection. No account, no sign-up, and nothing uploaded to a server. Share the link with several people and they share it with each other, or make it a one-time link that closes as soon as it has delivered.",
    path: "/qs",
  },
  qc: {
    title: "Start a video call with no account - Awful.chat",
    description:
      "A video call from one link: camera, screen share and text chat, with no account and no sign-up. Voice is peer-to-peer. Nothing is kept - close the tab and the call and its chat are gone.",
    path: "/qc",
  },
};

function setMeta(selector: string, attr: string, value: string): void {
  const el = document.head.querySelector(selector);
  if (el) el.setAttribute(attr, value);
}

/**
 * Point the document at whichever route is on screen. Called on every route
 * change, including a popstate back to the landing page, so the static values
 * have to be restorable - which is why `base` is read once, before anything
 * has been overwritten.
 */
let base: RouteMeta | null = null;

export function applyRouteMeta(route: string): void {
  if (typeof document === "undefined") return;
  base ??= {
    title: document.title,
    description:
      document.head
        .querySelector('meta[name="description"]')
        ?.getAttribute("content") ?? "",
    path: null,
  };
  const meta = META[route] ?? base;
  document.title = meta.title;
  setMeta('meta[name="description"]', "content", meta.description);
  setMeta('meta[property="og:title"]', "content", meta.title);
  setMeta('meta[property="og:description"]', "content", meta.description);
  setMeta('meta[name="twitter:title"]', "content", meta.title);
  setMeta('meta[name="twitter:description"]', "content", meta.description);
  if (meta.path) {
    const url = `${window.location.origin}${meta.path}`;
    setMeta('link[rel="canonical"]', "href", url);
    setMeta('meta[property="og:url"]', "content", url);
  }
}

/** Test seam: the module remembers index.html's values on first use. */
export function _resetPageMetaForTest(): void {
  base = null;
}
