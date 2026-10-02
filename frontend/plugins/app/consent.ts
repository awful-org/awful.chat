/**
 * Sites the person chose not to see the disclosure for again. Per device, by
 * origin: the origin is what receives the IP, cookies and storage, so every
 * app on je.frav.in is the same site to the person, and none on any other.
 * A phone's choice says nothing about a laptop.
 */

const KEY = "awful:apps-sites:v1";
const MAX_SITES = 200;

function read(): string[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((o): o is string => typeof o === "string") : [];
  } catch {
    return [];
  }
}

export function hasAgreed(origin: string): boolean {
  return read().includes(origin);
}

export function agree(origin: string): void {
  const sites = read().filter((o) => o !== origin);
  sites.push(origin);
  try {
    localStorage.setItem(KEY, JSON.stringify(sites.slice(-MAX_SITES)));
  } catch {
    // Storage blocked: the disclosure shows again next time, nothing worse.
  }
}

/** Show the disclosure for this site again. */
export function forget(origin: string): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(read().filter((o) => o !== origin)));
  } catch {
    // Storage blocked: nothing was remembered to begin with.
  }
}
