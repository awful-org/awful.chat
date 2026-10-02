/**
 * The host's half of the awful contract (docs/awful-contract.md): what an
 * app's messages may be, and what the host sends it. Pure, so the rules are
 * tested; AppTile wires them to the iframe.
 */

export const PROTOCOL = 1;
/** Per app, per second, and per message: the contract's limits. */
export const MAX_MESSAGES_PER_SECOND = 20;
export const MAX_MESSAGE_BYTES = 16 * 1024;

export interface Player {
  id: string;
  name: string;
  color: string | null;
}

export type AppMessage = { awful: 1; type: "ready" } | { awful: 1; type: "close" };

/**
 * An app's message, when it is one this host answers: from the iframe it
 * created, from the app's own origin, speaking this protocol, within size.
 * Anything else - another window, another origin, junk, a later version's
 * type - is null and ignored.
 */
export function readAppMessage(
  event: { source: unknown; origin: string; data: unknown },
  frame: unknown,
  origin: string,
): AppMessage | null {
  if (!frame || event.source !== frame || event.origin !== origin) return null;
  const data = event.data;
  if (typeof data !== "object" || data === null) return null;
  let json: string;
  try {
    json = JSON.stringify(data);
  } catch {
    return null;
  }
  // UTF-8 bytes, as the contract states the limit; a UTF-16 length undercounts
  // anything outside ASCII by up to three times.
  if (json.length > MAX_MESSAGE_BYTES || new TextEncoder().encode(json).length > MAX_MESSAGE_BYTES) return null;
  const { awful, type } = data as { awful?: unknown; type?: unknown };
  if (awful !== PROTOCOL) return null;
  if (type === "ready" || type === "close") return { awful: PROTOCOL, type };
  return null;
}

/** A sliding one-second window: true while the app is within its rate. */
export function rateLimiter(perSecond = MAX_MESSAGES_PER_SECOND, clock = () => Date.now()) {
  const times: number[] = [];
  return (): boolean => {
    const now = clock();
    while (times.length && now - times[0] >= 1000) times.shift();
    if (times.length >= perSecond) return false;
    times.push(now);
    return true;
  };
}

export function helloMessage(input: {
  sessionId: string;
  startedAt: number;
  args: string;
  self: Player;
  players: Player[];
  theme: "dark" | "light";
  locale: string;
}) {
  return {
    awful: PROTOCOL,
    type: "hello" as const,
    session: { id: input.sessionId, startedAt: input.startedAt, args: input.args },
    self: input.self,
    players: input.players,
    theme: input.theme,
    locale: input.locale,
  };
}
