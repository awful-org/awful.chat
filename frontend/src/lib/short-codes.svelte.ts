import { hostInvitationPairing } from "./invite-pairing";
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
export interface ShortCode { code: string; expiresAt: number }

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

/** The live code for the room when it has time left, else a new one. */
export function hostShortCode(secret: RoomSecret): Promise<ShortCode> {
  const current = live[secret];
  if (current && current.expiresAt - Date.now() > REUSE_MIN_MS) return Promise.resolve(current);
  let request = pending.get(secret);
  if (!request) {
    request = (async () => {
      cancelShortCode(secret);
      const session = { cancel: () => {} };
      const made = await hostInvitationPairing(secret, (status) => {
        if (sessions.get(secret) !== session) return;
        sessions.delete(secret);
        delete live[secret];
        outcome[secret] = status;
      });
      session.cancel = made.cancel;
      sessions.set(secret, session);
      return (live[secret] = { code: made.code, expiresAt: made.expiresAt });
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
