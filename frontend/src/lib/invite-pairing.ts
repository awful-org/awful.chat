import { apiUrl } from "./runtime-config";
import {
  InvitationPairingHost,
  PAIRING_MAX_TTL,
  PAIRING_TTL,
  formatPairingCode,
  pairingLimits,
  startPairingJoin,
  type PairingLimits,
} from "./room-security/invitation-pairing";
import type { RoomSecret } from "./room-security/keys";

interface Message { attempt: string; kind: string; payload: string }

/** A pairing request the relay refused, with its status for the caller. */
class PairingRequestError extends Error {
  constructor(readonly status: number) {
    super("Pairing unavailable or expired. Request a new code.");
  }
}

/**
 * Fresh locators to try when the relay answers 409 "already in use". The
 * locator is two characters (invitation-pairing.ts), so two live pairings
 * can land on the same one; a new draw almost always clears it.
 */
const CREATE_TRIES = 6;
async function request(body: Record<string, unknown>, signal?: AbortSignal): Promise<{ token?: string; messages: Message[] }> {
  const response = await fetch(`${apiUrl()}/invite`, {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ version: 2, ...body }), cache: "no-store",
    signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(10000)]) : AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new PairingRequestError(response.status);
   const reader = response.body?.getReader();
   if (!reader) throw new Error("Invalid pairing response");
   const chunks: Uint8Array[] = [];
   let size = 0;
   try {
     for (;;) {
       const { done, value } = await reader.read();
       if (done) break;
       size += value.length;
       if (size > 16384) throw new Error("Invalid pairing response");
       chunks.push(value);
     }
   } finally { await reader.cancel(); }
   const bytes = new Uint8Array(size);
   let offset = 0;
   for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.length; }
   const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
   const result = JSON.parse(text);
   if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("Invalid pairing response");
  if (result.messages !== undefined && (!Array.isArray(result.messages) || result.messages.length > 10 || result.messages.some((m: Message) => !m || typeof m.attempt !== "string" || typeof m.kind !== "string" || typeof m.payload !== "string" || m.payload.length > 2048))) throw new Error("Invalid pairing response");
  return { ...result, messages: result.messages ?? [] };
}
const pause = () => new Promise<void>(resolve => setTimeout(resolve, 1500));

/** How long a rate-limited pairing request waits before it asks again. */
const RATE_LIMIT_WAIT_MS = 5_000;

function wait(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
  });
}

/**
 * Send a pairing request, and when the relay says slow down (429), wait and
 * send it again while `alive()` holds. The relay paces an address - a
 * roomful of people typing one group code behind one network is one address
 * - and a refusal there used to end that person's join for good. A paced
 * request spends nothing: the relay refuses before it counts an attempt.
 * `onWait` hears each wait, so a deadline can leave it out.
 */
async function paced<T>(send: () => Promise<T>, alive: () => boolean, signal?: AbortSignal, onWait?: (ms: number) => void): Promise<T> {
  for (;;) {
    try {
      return await send();
    } catch (err) {
      if (!(err instanceof PairingRequestError && err.status === 429) || !alive()) throw err;
      await wait(RATE_LIMIT_WAIT_MS, signal);
      onWait?.(RATE_LIMIT_WAIT_MS);
    }
  }
}

/**
 * Host a short code for a room until it has let in everyone it was made for,
 * runs out, or is cancelled. `onJoined` hears each person who got in;
 * `onStatus` hears once, when the code is over.
 */
export async function hostInvitationPairing(
  secret: RoomSecret,
  onStatus: (status: string) => void,
  signal?: AbortSignal,
  limits: PairingLimits = {},
  onJoined?: (joined: number) => void,
) {
  signal?.throwIfAborted();
  const { uses, ttlMs } = pairingLimits(limits);
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let host!: InvitationPairingHost;
  let token: string | undefined;
  for (let tries = 1; ; tries++) {
    // A new host per try: the locator is bound into its OPAQUE registration.
    host = await InvitationPairingHost.create(secret, Date.now, { uses, ttlMs });
    try {
      combined.throwIfAborted();
      // The relay holds the code to the same limits, whatever this tab does.
      // Defaults go unsaid: a relay from before limits refuses the fields.
      ({ token } = await request({
        action: "create", locator: host.locator,
        ...(uses !== 1 && { uses }),
        ...(ttlMs !== PAIRING_TTL && { ttl: Math.round(ttlMs / 1000) }),
      }, combined));
      break;
    } catch (err) {
      host.cancel();
      const taken = err instanceof PairingRequestError && err.status === 409;
      if (!taken || tries >= CREATE_TRIES) throw err;
    }
  }
  if (!token || !/^[A-Za-z0-9_-]{43}$/.test(token)) { host.cancel(); throw new Error("Invalid pairing response"); }
  let cancelled = false;
  const cancel = () => {
    if (cancelled) return;
    cancelled = true; host.cancel(); controller.abort();
    signal?.removeEventListener("abort", cancel);
    void request({ action: "cancel", locator: host.locator, token }).catch(() => {});
  };
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) { cancel(); signal.throwIfAborted(); }
  const run = async () => {
    try {
      while (host.active && !cancelled) {
        const alive = () => host.active && !cancelled;
        const { messages } = await paced(() => request({ action: "host-poll", locator: host.locator, token }, controller.signal), alive, controller.signal);
        for (const m of messages) {
          if (cancelled || !host.active) break;
          let payload: string;
          try {
            payload = m.kind === "start" ? host.start(m.attempt, m.payload) : m.kind === "finish" ? await host.finish(m.attempt, m.payload) : "";
          } catch { continue; } // Host counts every start, including malformed requests.
          if (!payload || cancelled) continue;
          // A transfer is still owed after the code closes on its last person.
          await paced(
            () => request({ action: "reply", locator: host.locator, token, attempt: m.attempt, kind: m.kind === "start" ? "response" : "transfer", payload }, controller.signal),
            () => !cancelled,
            controller.signal,
          );
          if (m.kind === "finish") {
            onJoined?.(host.joined);
            if (host.joined >= host.uses) {
              onStatus(host.uses === 1
                ? "Invitation delivered. This code is now used."
                : `All ${host.uses} people joined. This code is now used.`);
              return;
            }
          }
        }
        // A full batch may have more behind it (the relay hands out a few
        // at a time): ask again at once.
        if (!messages.length) await pause();
      }
      if (!cancelled) {
        onStatus(host.joined > 0
          ? `Code expired after ${host.joined} of ${host.uses} joined.`
          : "Pairing expired. Generate a new code.");
      }
    } catch {
      if (!cancelled) {
        onStatus("Pairing stopped. Generate a new code.");
        // No one answers this code any more: close it at the relay too, so
        // the people still to join are refused rather than left waiting.
        void request({ action: "cancel", locator: host.locator, token }).catch(() => {});
      }
    }
    finally { host.cancel(); signal?.removeEventListener("abort", cancel); }
  };
  void run();
  return { code: formatPairingCode(host.locator, host.password), expiresAt: host.expiresAt, uses: host.uses, cancel };
}

export async function joinInvitationPairing(code: string, signal: AbortSignal): Promise<RoomSecret> {
  signal.throwIfAborted();
  const join = await startPairingJoin(code);
  // However the pairing ends - delivered, refused, cancelled, timed out -
  // its secrets go with it.
  try {
    signal.throwIfAborted();
    const base = { locator: join.locator, attempt: join.attempt };
    // A minute of the inviter's attention, not counting time the relay asked
    // us to wait: a group behind one network is paced, not timed out.
    // Never past the longest a code can live, however often it was paced.
    const started = Date.now();
    let deadline = started + 60_000;
    const alive = () => { const t = Date.now(); return t < deadline && t < started + PAIRING_MAX_TTL; };
    const waited = (ms: number) => { deadline += ms; };
    await paced(() => request({ ...base, action: "start", kind: "start", payload: join.request }, signal), alive, signal, waited);
    while (!signal.aborted && alive()) {
      const { messages } = await paced(() => request({ ...base, action: "join-poll" }, signal), alive, signal, waited);
      for (const m of messages) {
        if (m.attempt !== join.attempt) throw new Error("Invalid pairing attempt");
        if (m.kind === "response") {
          const proof = join.respond(m.payload);
          await paced(() => request({ ...base, action: "finish", kind: "finish", payload: proof }, signal), alive, signal, waited);
        }
        else if (m.kind === "transfer") {
          const secret = await join.open(m.payload);
          signal.throwIfAborted();
          return secret;
        }
        else throw new Error("Invalid pairing message");
      }
      await pause();
    }
    throw new Error("Pairing cancelled or timed out. Keep the inviter online and request a new code.");
  } finally {
    join.dispose();
  }
}
