/**
 * Sites this device has agreed to open apps from, after the disclosure. Per
 * device, by origin: agreeing on a phone says nothing about a laptop, and
 * agreeing to je.frav.in says nothing about any other site.
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
