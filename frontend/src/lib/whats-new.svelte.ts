/**
 * The live half of Settings > What's new: the list, loaded once from this
 * instance's own /whats-new.json, and the dot that says it holds something
 * this device has not opened yet. Device-local, like display-prefs.
 */

import { hasUnseen, newestMerge, parseWhatsNew, type ReleaseNote } from "./whats-new";

// v2: the newest merge time seen, in ms (v1 held a pull request number).
const SEEN_KEY = "awful:whats-new-seen:v2";

function readSeen(): number | null {
  try {
    const raw = localStorage.getItem(SEEN_KEY);
    const n = raw === null ? NaN : Number(raw);
    return Number.isSafeInteger(n) ? n : null;
  } catch {
    return null;
  }
}

function writeSeen(n: number): void {
  try {
    localStorage.setItem(SEEN_KEY, String(n));
  } catch {
    // Storage blocked: the dot comes back next load, nothing worse.
  }
}

export const whatsNew = $state({
  notes: [] as ReleaseNote[],
  /** "loading" until the file answered; "none" when there is no list. */
  status: "idle" as "idle" | "loading" | "ready" | "none",
  unseen: false,
});

let loading: Promise<void> | null = null;

/**
 * Fetch the list once per page. Safe to call from anywhere, any number of
 * times. A load that found nothing is tried again on the next call: the
 * server writes the file a moment after it starts, so a page loaded in that
 * moment would otherwise keep "nothing to show" until it reloads.
 */
export function loadWhatsNew(): Promise<void> {
  loading ??= (async () => {
    whatsNew.status = "loading";
    try {
      const base = (import.meta.env.BASE_URL || "/").replace(/\/$/, "");
      const res = await fetch(`${base}/whats-new.json`, {
        cache: "no-cache",
        signal: AbortSignal.timeout(10_000),
      });
      // A dev server or an old image may answer with the app page instead.
      const type = res.headers.get("content-type") ?? "";
      if (!res.ok || !/json/i.test(type)) {
        whatsNew.status = "none";
        return;
      }
      const notes = parseWhatsNew(await res.json());
      whatsNew.notes = notes;
      whatsNew.status = notes.length ? "ready" : "none";
      const seen = readSeen();
      // A device that never looked starts caught up.
      if (seen === null && notes.length) writeSeen(newestMerge(notes));
      whatsNew.unseen = hasUnseen(notes, seen);
    } catch {
      whatsNew.status = "none";
    } finally {
      if (whatsNew.status === "none") loading = null;
    }
  })();
  return loading;
}

/** The tab was opened: everything listed now counts as seen. */
export function markWhatsNewSeen(): void {
  if (!whatsNew.notes.length) return;
  writeSeen(newestMerge(whatsNew.notes));
  whatsNew.unseen = false;
}

// Another tab opened the list: take the dot down here too.
if (typeof window !== "undefined") {
  window.addEventListener("storage", (e) => {
    if (e.key !== SEEN_KEY) return;
    whatsNew.unseen = hasUnseen(whatsNew.notes, readSeen());
  });
}
