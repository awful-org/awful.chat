/**
 * Offline DM mailbox client: deposits sealed envelopes for offline peers
 * and collects ours on a timer. On by default (delivery needs BOTH the
 * sender depositing and the recipient collecting, so opt-in defaults made
 * it dead in practice), with a per-device opt-out - the relay learns
 * delivery timing, padded sizes and the recipient mailbox (never content,
 * never the sender's identity), and the Quirks tab says so.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { requireSession, isUnlocked } from "$lib/identity/identity";
import {
  sealDmForMailbox,
  openDmFromMailbox,
  mailboxIdForDid,
  type MailboxKind,
} from "$lib/mailbox-crypto";
import { parseDmEnvelope } from "./dm-codec";
import {
  _transport,
  deliverMailboxBatch,
  deliverMailboxDm,
  deliverMailboxReceipt,
} from "./transport.svelte";
import { apiUrl } from "$lib/runtime-config";
import { ev, errText } from "$lib/telemetry/event";
import { rec } from "$lib/telemetry/recorder";

const OPTIN_KEY = "awful:mailbox-optin:v1";
// A call, not a const: this module is imported while the app is still
// starting, and a value captured here would freeze whatever the build baked
// in before /config.json had been read.
const API = () => apiUrl();
const COLLECT_EVERY = 5 * 60 * 1000;
/** Bound on a mailbox round trip. A phone that lost its network mid-request
 *  otherwise leaves `_collecting` latched and no collect ever runs again. */
const HTTP_TIMEOUT_MS = 15_000;
/** One retry for a deposit the relay refused with "busy", not "no". */
const DEPOSIT_RETRY_MS = 30_000;
/** How long a rate-limited collector waits before trying again. */
const COLLECT_BACKOFF_MS = 60_000;

export const mailboxPrefs = $state({
  // Anything but an explicit "off" means on - including devices from the
  // opt-in era that never touched the toggle.
  enabled:
    typeof localStorage === "undefined" ||
    localStorage.getItem(OPTIN_KEY) !== "0",
});

export function setMailboxEnabled(on: boolean): void {
  mailboxPrefs.enabled = on;
  try {
    localStorage.setItem(OPTIN_KEY, on ? "1" : "0");
  } catch {
    // Choice just does not survive a reload.
  }
  if (on) void collectMailbox();
}

const b64 = (u: Uint8Array): string => btoa(String.fromCharCode(...u));
const unb64 = (s: string): Uint8Array =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * Why a deposit did not land, so the caller can say something useful.
 *
 * "oversized" is the one the user can act on: the message is too big for the
 * mailbox's largest padding bucket and will only ever go peer to peer, so
 * the recipient has to be online at the same time as them.
 */
export type MailboxDepositResult =
  | "sent"
  | "oversized"
  | "disabled"
  | "failed";

async function postDeposit(
  box: string,
  blob: string,
  attempt = 0
): Promise<boolean> {
  const res = await fetch(`${API()}/mailbox/deposit`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ box, blob }),
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  rec(
    ev("dm.mailbox.deposit", { d: { status: res.status, attempt, ok: res.ok } })
  );
  if (res.ok) return true;
  // 429 and 5xx are "come back", not "no": a relay restart or a rate limit
  // that a single retry clears. Anything else is a refusal, and the P2P
  // queue remains the fallback for both.
  if ((res.status === 429 || res.status >= 500) && attempt === 0) {
    setTimeout(() => {
      void postDeposit(box, blob, 1).catch(() => {});
    }, DEPOSIT_RETRY_MS);
  }
  return false;
}

/** Best-effort deposit for an offline peer. The P2P offline queue keeps
 *  retrying regardless, this only shortens the wait - but the reason comes
 *  back so an oversized message can say why it will not use the inbox. */
export async function depositDmToMailbox(
  recipientDid: string,
  envelope: Uint8Array,
  kind: MailboxKind = "chat"
): Promise<MailboxDepositResult> {
  if (!mailboxPrefs.enabled || !API() || !isUnlocked()) return "disabled";
  if (!recipientDid.startsWith("did:key:")) return "disabled";
  try {
    const session = requireSession();
    const blob = await sealDmForMailbox({
      senderDid: session.did,
      senderPrivateKey: session.privateKey,
      recipientDid,
      envelope,
      kind,
    });
    // Over the largest padding bucket: P2P retry is the only route left.
    if (!blob) return "oversized";
    const ok = await postDeposit(await mailboxIdForDid(recipientDid), b64(blob));
    return ok ? "sent" : "failed";
  } catch (err) {
    // Relay down or box full: nothing lost, only slower.
    rec(ev("dm.mailbox.deposit", { d: { err: errText(err) } }));
    return "failed";
  }
}

/**
 * Auth for collect and ack.
 *
 * `device` is this browser's libp2p peerId. The relay hides an acked blob
 * from THAT device and keeps it to its TTL, so a second device signed into
 * the same identity still collects it - the message-id dedup against storage
 * is what stops it being filed twice.
 */
function authFields(): {
  did: string;
  ts: number;
  sig: string;
  device: string;
} {
  const session = requireSession();
  const ts = Math.floor(Date.now() / 1000);
  const sig = ed25519.sign(
    new TextEncoder().encode(`awful-mailbox:${ts}`),
    session.privateKey
  );
  return { did: session.did, ts, sig: b64(sig), device: _transport.selfId() };
}

let _collecting = false;
/** Set when the relay told us to slow down; nothing collects before it. */
let _collectPausedUntil = 0;

/** Fetch, verify, deliver and ack everything waiting for us. */
export async function collectMailbox(): Promise<void> {
  if (!mailboxPrefs.enabled || !API() || !isUnlocked() || _collecting) return;
  if (Date.now() < _collectPausedUntil) return;
  _collecting = true;
  try {
    const session = requireSession();
    const res = await fetch(`${API()}/mailbox/collect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(authFields()),
      // Without a deadline a request that never settles latches _collecting
      // for the rest of the session and the mailbox goes quiet for good.
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (!res.ok) {
      rec(ev("dm.mailbox.collect", { d: { status: res.status } }));
      if (res.status === 401) {
        // The signature covers a unix second. The usual cause is not a bad
        // key but a device clock the relay disagrees with.
        console.warn(
          "[mailbox] collect rejected (401): check this device's clock against the relay"
        );
      }
      if (res.status === 429 || res.status >= 500) {
        _collectPausedUntil = Date.now() + COLLECT_BACKOFF_MS;
      }
      return;
    }
    const entries = (await res.json()) as Array<{ id: string; blob: string }>;
    if (!Array.isArray(entries) || entries.length === 0) return;

    const done: string[] = [];
    for (const entry of entries) {
      // Decrypt/parse failures are POISON: deterministic, ack them away so
      // they stop rotting in the box. Delivery failures are TRANSIENT (the
      // classic one: the identity locked mid-drain, so the storage write
      // threw) - the blob must stay in the box for the next tick, because
      // an ack deletes the only copy.
      let job: (() => Promise<void>) | null = null;
      try {
        const { senderDid, envelope, kind } = await openDmFromMailbox({
          blob: unb64(entry.blob),
          selfDid: session.did,
          selfPrivateKey: session.privateKey,
        });
        if (kind === "batch") {
          // Files, plugin cards and plugin updates in a DM: a signed
          // SyncBatch, filed into the room derived from both DIDs.
          job = () => deliverMailboxBatch(senderDid, envelope);
        } else {
          const parsed = parseDmEnvelope(envelope);
          if (parsed?.type === "chat") {
            const payload = parsed.payload;
            job = () => deliverMailboxDm(senderDid, payload);
          } else if (parsed?.type === "ack" || parsed?.type === "read") {
            // Receipts, so the sender's ticks move once the recipient
            // collects rather than waiting for the two of them to be online
            // together.
            const receipt = parsed;
            job = () => deliverMailboxReceipt(senderDid, receipt);
          }
        }
      } catch (err) {
        console.warn("[mailbox] dropped blob:", err);
        rec(ev("dm.mailbox.drop", { d: { err: errText(err) } }));
        done.push(entry.id);
        continue;
      }
      try {
        if (job) await job();
        done.push(entry.id);
      } catch (err) {
        console.warn("[mailbox] delivery failed, keeping blob:", err);
        rec(
          ev("dm.mailbox.collect", {
            d: { err: errText(err), delivered: false },
          })
        );
      }
    }
    if (done.length > 0) {
      const ack = await fetch(`${API()}/mailbox/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...authFields(), ids: done }),
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      if (!ack.ok) {
        // Nothing is lost: the blobs stay in the box and the next collect
        // redelivers them, where the id dedup drops the duplicates.
        rec(ev("dm.mailbox.collect", { d: { ackStatus: ack.status } }));
        if (ack.status === 429 || ack.status >= 500) {
          _collectPausedUntil = Date.now() + COLLECT_BACKOFF_MS;
        }
        return;
      }
      console.log(`[mailbox] collected ${done.length} offline DM(s)`);
      // The generic "New message" push notification stood for this mail;
      // it is answered now. Lazy: notify pulls UI-side modules.
      void import("$lib/notify.svelte")
        .then(({ closeNotificationsByTag }) => closeNotificationsByTag(["mail"]))
        .catch(() => {});
      rec(ev("dm.mailbox.collect", { d: { count: done.length } }));
    }
  } catch {
    // Offline or relay down: the next tick retries.
  } finally {
    _collecting = false;
  }
}

let _timer: ReturnType<typeof setInterval> | undefined;
let _wakeBound = false;

/** Start the collect loop. Idempotent; call after unlock. */
export function startMailboxCollector(): void {
  if (_timer) return;
  void collectMailbox();
  _timer = setInterval(() => void collectMailbox(), COLLECT_EVERY);

  // The interval alone means a worst case of COLLECT_EVERY, and worse than that
  // in a background tab, where timers are throttled hard. Coming back to the
  // app is the moment a waiting DM matters most, so drain then as well.
  // `collectMailbox` already guards re-entry, so an extra call is free.
  if (_wakeBound || typeof document === "undefined") return;
  _wakeBound = true;
  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) void collectMailbox();
  });
  window.addEventListener("online", () => void collectMailbox());
}
