/**
 * Offline DM mailbox client: deposits sealed envelopes for offline peers
 * and collects ours on a timer. On by default (delivery needs BOTH the
 * sender depositing and the recipient collecting, so opt-in defaults made
 * it dead in practice), with a per-device opt-out - the relay learns
 * delivery timing, padded sizes and the recipient mailbox (never content,
 * never the sender's identity), and the Quirks tab says so.
 */

import { ed25519 } from "@noble/curves/ed25519.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { requireSession, isUnlocked } from "$lib/identity/identity";
import {
  sealDmForMailbox,
  openDmFromMailbox,
  mailboxIdForDid,
  type MailboxKind,
} from "$lib/mailbox-crypto";
import { peerPqKey } from "$lib/identity/pq-peers";
import { parseDmEnvelope } from "./dm-codec";
import {
  _transport,
  broadcastProfile,
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
  // The profile carries it, so the people who DM us can say when a message
  // will only arrive while we are both online.
  broadcastProfile();
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
    // Hybrid (post-quantum) whenever they have published a PQ key: the relay
    // keeps these blobs, and a stored blob is exactly what a recording
    // attacker gets to keep. A lookup failure means v1, never no delivery.
    const recipientPqKey = await peerPqKey(recipientDid).catch(() => null);
    const blob = await sealDmForMailbox({
      senderDid: session.did,
      senderPrivateKey: session.privateKey,
      recipientDid,
      envelope,
      kind,
      recipientPqKey,
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

/** The authenticated relay calls, each signed as itself. */
export type MailboxAction =
  | "collect"
  | "ack"
  | "push-subscribe"
  | "push-unsubscribe";

const hex = (u: Uint8Array): string =>
  Array.from(u, (b) => b.toString(16).padStart(2, "0")).join("");

/**
 * The string a v2 mailbox proof signs, byte for byte what the relay checks
 * (mailboxAuthMessage in relay/mailbox.go):
 *
 *   awful-mailbox:v2:<action>:<host>:<device>:<ts>:<hex sha256 of the body>
 *
 * The old proof signed only `awful-mailbox:<ts>`, so one captured request
 * was good for any of the four calls for a couple of minutes: replayed as
 * an ack naming another device, or as a push subscribe carrying somebody
 * else's endpoint. Signing the action, the relay's host, the device and the
 * whole body makes a proof good for the one request it came with, and the
 * relay accepts each proof once.
 */
export function mailboxAuthMessage(
  action: MailboxAction,
  host: string,
  device: string,
  ts: number,
  body: string
): string {
  const digest = hex(sha256(new TextEncoder().encode(body)));
  return `awful-mailbox:v2:${action}:${host}:${device}:${ts}:${digest}`;
}

/** The relay's host as this request addresses it - what the relay reads
 *  back from its Host header. */
function relayHost(): string {
  const base = typeof location === "undefined" ? undefined : location.href;
  return new URL(API(), base).host;
}

/**
 * Body and headers for an authenticated call. The proof rides in the
 * Authorization header because it cannot sit inside the body it signs, and
 * the body carries a random nonce so two otherwise identical requests in
 * one second are still two proofs.
 *
 * `device` is this browser's libp2p peerId. The relay hides an acked blob
 * from THAT device and keeps it to its TTL, so a second device signed into
 * the same identity still collects it - the message-id dedup against storage
 * is what stops it being filed twice.
 */
function signedRequest(
  action: MailboxAction,
  payload: Record<string, unknown>,
  device: string
): { headers: Record<string, string>; body: string } {
  const session = requireSession();
  const nonce = hex(crypto.getRandomValues(new Uint8Array(16)));
  const body = JSON.stringify({ ...payload, device, nonce });
  const ts = Math.floor(Date.now() / 1000);
  const sig = ed25519.sign(
    new TextEncoder().encode(
      mailboxAuthMessage(action, relayHost(), device, ts, body)
    ),
    session.privateKey
  );
  return {
    headers: {
      "Content-Type": "application/json",
      Authorization: `AwfulMailbox-v2 ${session.did} ${ts} ${b64(sig)}`,
    },
    body,
  };
}

let _collecting = false;
/** Set when the relay told us to slow down; nothing collects before it. */
let _collectPausedUntil = 0;

/** Fetch, verify, deliver and ack everything waiting for us. */
export async function collectMailbox(): Promise<void> {
  if (!mailboxPrefs.enabled || !API() || !isUnlocked() || _collecting) return;
  if (Date.now() < _collectPausedUntil) return;
  // Not before this device has its id, which only a started node gives it.
  // A collect naming no device is answered with every blob, acked or not,
  // and its ack deletes them for all of our devices - and the first collect
  // after every page load went out like that, re-delivering the whole box
  // and a receipt per DM still in it. Connecting to the relay collects again.
  const device = _transport.selfId();
  if (!device) return;
  _collecting = true;
  try {
    const session = requireSession();
    const res = await fetch(`${API()}/mailbox/collect`, {
      method: "POST",
      ...signedRequest("collect", {}, device),
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
        ...signedRequest("ack", { ids: done }, device),
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
