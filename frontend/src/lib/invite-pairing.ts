import { apiUrl } from "./runtime-config";
import { InvitationPairingHost, formatPairingCode, startPairingJoin } from "./room-security/invitation-pairing";
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

export async function hostInvitationPairing(secret: RoomSecret, onStatus: (status: string) => void, signal?: AbortSignal) {
  signal?.throwIfAborted();
  const controller = new AbortController();
  const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
  let host!: InvitationPairingHost;
  let token: string | undefined;
  for (let tries = 1; ; tries++) {
    // A new host per try: the locator is bound into its OPAQUE registration.
    host = await InvitationPairingHost.create(secret);
    try {
      combined.throwIfAborted();
      ({ token } = await request({ action: "create", locator: host.locator }, combined));
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
        const { messages } = await request({ action: "host-poll", locator: host.locator, token }, controller.signal);
        for (const m of messages) {
          if (cancelled || !host.active) break;
          let payload: string;
          try {
            payload = m.kind === "start" ? host.start(m.attempt, m.payload) : m.kind === "finish" ? await host.finish(m.attempt, m.payload) : "";
          } catch { continue; } // Host counts every start, including malformed requests.
          if (!payload || cancelled) continue;
          await request({ action: "reply", locator: host.locator, token, attempt: m.attempt, kind: m.kind === "start" ? "response" : "transfer", payload }, controller.signal);
          if (m.kind === "finish") { onStatus("Invitation delivered. This code is now used."); return; }
        }
        await pause();
      }
      if (!cancelled) onStatus("Pairing expired. Generate a new code.");
    } catch { if (!cancelled) onStatus("Pairing stopped. Generate a new code."); }
    finally { host.cancel(); signal?.removeEventListener("abort", cancel); }
  };
  void run();
  return { code: formatPairingCode(host.locator, host.password), expiresAt: host.expiresAt, cancel };
}

export async function joinInvitationPairing(code: string, signal: AbortSignal): Promise<RoomSecret> {
  signal.throwIfAborted();
  const join = await startPairingJoin(code);
  signal.throwIfAborted();
  const base = { locator: join.locator, attempt: join.attempt };
  await request({ ...base, action: "start", kind: "start", payload: join.request }, signal);
  const deadline = Date.now() + 60_000;
  while (!signal.aborted && Date.now() < deadline) {
    const { messages } = await request({ ...base, action: "join-poll" }, signal);
    for (const m of messages) {
      if (m.attempt !== join.attempt) throw new Error("Invalid pairing attempt");
      if (m.kind === "response") await request({ ...base, action: "finish", kind: "finish", payload: join.respond(m.payload) }, signal);
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
}
