import { parseCallLayout, type CallLayoutPrefs } from "./call-layout";

const KEY = "awful:call-layout:v1";
function read(): string | null {
  try { return localStorage.getItem(KEY); } catch { return null; }
}
export const callLayoutPrefs = $state(parseCallLayout(read()));

export function setCallLayoutPrefs(patch: Partial<CallLayoutPrefs>): void {
  Object.assign(callLayoutPrefs, patch);
  try { localStorage.setItem(KEY, JSON.stringify(callLayoutPrefs)); } catch { /* Device-local, best effort. */ }
}

if (typeof window !== "undefined") {
  window.addEventListener("storage", (event) => {
    if (event.key === KEY || event.key === null) Object.assign(callLayoutPrefs, parseCallLayout(event.newValue));
  });
}
