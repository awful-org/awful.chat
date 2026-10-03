/**
 * platform.ts - what this machine calls its modifier keys.
 *
 * Every shortcut the app binds takes Cmd on a Mac where it takes Ctrl
 * elsewhere, so every label for one has to follow the same rule. Shortcuts are
 * written once with "Mod" for that key and formatted here: "⌘K" on a Mac,
 * "Ctrl+K" everywhere else.
 */

/** The parts of `navigator` read here, so a test can hand in its own. */
export interface NavigatorLike {
  userAgentData?: { platform?: string };
  platform?: string;
  userAgent?: string;
}

/**
 * A Mac, or an iPhone or iPad: anything whose keyboard has Cmd where others
 * have Ctrl. Client hints first, since Chromium is freezing the user agent
 * string. An iPad asking for the desktop site already says "MacIntel", which
 * is right here: with a keyboard attached it takes Cmd like a Mac does.
 */
export function isMacLike(
  nav: NavigatorLike | undefined = typeof navigator === "undefined"
    ? undefined
    : (navigator as NavigatorLike)
): boolean {
  if (!nav) return false;
  const hinted = nav.userAgentData?.platform;
  if (hinted) return hinted === "macOS" || hinted === "iOS";
  if (nav.platform) return /^(Mac|iPhone|iPad|iPod)/.test(nav.platform);
  return /Macintosh|iPhone|iPad|iPod/.test(nav.userAgent ?? "");
}

/**
 * Mac glyphs, in the order the Mac's own menus list them (Control, Option,
 * Shift, Command). "Mod" is the app's shortcut key: Cmd here, Ctrl elsewhere.
 * "Ctrl" means the Control key itself and stays ⌃.
 */
const MAC_MODIFIERS = new Map([
  ["Ctrl", "⌃"],
  ["Alt", "⌥"],
  ["Shift", "⇧"],
  ["Mod", "⌘"],
]);

/**
 * One key per `<kbd>`: ["Mod", "Shift", "F"] is ["⇧", "⌘", "F"] on a Mac and
 * ["Ctrl", "Shift", "F"] elsewhere. Keys that are not modifiers pass through.
 */
export function shortcutKeys(
  keys: readonly string[],
  mac: boolean = isMacLike()
): string[] {
  if (!mac) return keys.map((key) => (key === "Mod" ? "Ctrl" : key));
  const modifiers = [...MAC_MODIFIERS]
    .filter(([name]) => keys.includes(name))
    .map(([, glyph]) => glyph);
  return [...modifiers, ...keys.filter((key) => !MAC_MODIFIERS.has(key))];
}

/** The same shortcut as running text: "⌘K" on a Mac, "Ctrl+K" elsewhere. */
export function shortcutLabel(
  keys: readonly string[],
  mac: boolean = isMacLike()
): string {
  return shortcutKeys(keys, mac).join(mac ? "" : "+");
}
