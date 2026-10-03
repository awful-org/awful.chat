import { hostInvitationPairing } from "./invite-pairing";
import { pairingLimits, type PairingLimits } from "./room-security/invitation-pairing";
import type { RoomSecret } from "./room-security/keys";

/**
 * The short codes this tab is hosting, by room secret.
 *
 * They live here, not in the view that asked for one. The inviter's tab has to
 * answer the pairing, but nothing needs the "Room created" modal or the invite
 * dialog to stay open. When the code belonged to the view, closing it or
 * joining the room just created killed a code already handed out. Memory only,
 * like the secret the host itself holds: a reload or a lock ends them.
 */
export interface ShortCode {
  code: string;
  expiresAt: number;
  /** People it lets in, and how many it has so far. */
  uses: number;
  joined: number;
  /** The lifetime it was asked for, to tell a request for the same code apart. */
  ttlMs: number;
}

const live = $state<Record<string, ShortCode>>({});
// How the last code for a room ended ("delivered", "expired"), until the next.
const outcome = $state<Record<string, string>>({});
const sessions = new Map<string, { cancel: () => void }>();
const pending = new Map<string, Promise<ShortCode>>();

/** Less than this left and a request mints a fresh code instead. */
const REUSE_MIN_MS = 60_000;

export function liveShortCode(secret: RoomSecret): ShortCode | null {
  return live[secret] ?? null;
}

export function shortCodeOutcome(secret: RoomSecret): string | null {
  return outcome[secret] ?? null;
}

/** The link form: `/r/#<code>` joins like a typed code, see AppView's parseRoomCode. */
export function shortCodeLink(code: string): string {
  return `${window.location.origin}/r/#${code}`;
}

/**
 * The live code for the room when it has time left, else a new one (which
 * ends the old). Asked with limits, a live code counts only if it was made
 * with the same ones; asked without (a quick "copy short code"), any live
 * code does, so it never cuts short a code made for a group.
 */
export function hostShortCode(secret: RoomSecret, limits?: PairingLimits): Promise<ShortCode> {
  const wanted = pairingLimits(limits);
  const current = live[secret];
  if (
    // Half its life for a code shorter than two minutes, or a one-minute
    // code could never be handed back.
    current && current.expiresAt - Date.now() > Math.min(REUSE_MIN_MS, current.ttlMs / 2) &&
    (!limits || (current.uses === wanted.uses && current.ttlMs === wanted.ttlMs))
  ) return Promise.resolve(current);
  let request = pending.get(secret);
  // A code still being made for other limits is not this one: wait for it,
  // then ask again, which replaces it with what was asked for here.
  if (request && limits) {
    const inFlight = request;
    return inFlight.catch(() => null).then((made) =>
      made && made.uses === wanted.uses && made.ttlMs === wanted.ttlMs ? made : hostShortCode(secret, limits),
    );
  }
  if (!request) {
    request = (async () => {
      cancelShortCode(secret);
      const session = { cancel: () => {} };
      const made = await hostInvitationPairing(
        secret,
        (status) => {
          if (sessions.get(secret) !== session) return;
          sessions.delete(secret);
          delete live[secret];
          outcome[secret] = status;
        },
        undefined,
        wanted,
        (joined) => {
          if (sessions.get(secret) === session && live[secret]) live[secret].joined = joined;
        },
      );
      session.cancel = made.cancel;
      sessions.set(secret, session);
      return (live[secret] = { code: made.code, expiresAt: made.expiresAt, uses: made.uses, joined: 0, ttlMs: wanted.ttlMs });
    })().finally(() => pending.delete(secret));
    pending.set(secret, request);
  }
  return request;
}

export function cancelShortCode(secret: RoomSecret): void {
  const session = sessions.get(secret);
  sessions.delete(secret);
  session?.cancel();
  delete live[secret];
  delete outcome[secret];
}

export function cancelAllShortCodes(): void {
  for (const secret of [...sessions.keys()]) cancelShortCode(secret as RoomSecret);
}
