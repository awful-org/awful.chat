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
} from "$lib/mailbox-crypto";
import { parseDmEnvelope } from "./dm-codec";
import { deliverMailboxDm } from "./transport.svelte";
import { apiUrl } from "$lib/runtime-config";

const OPTIN_KEY = "awful:mailbox-optin:v1";
// A call, not a const: this module is imported while the app is still
// starting, and a value captured here would freeze whatever the build baked
// in before /config.json had been read.
const API = () => apiUrl();
const COLLECT_EVERY = 5 * 60 * 1000;

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

/** Best-effort deposit for an offline peer. Failures are silent: the P2P
 *  offline queue keeps retrying regardless, this only shortens the wait. */
export async function depositDmToMailbox(
  recipientDid: string,
  envelope: Uint8Array
): Promise<void> {
  if (!mailboxPrefs.enabled || !API() || !isUnlocked()) return;
  if (!recipientDid.startsWith("did:key:")) return;
  try {
    const session = requireSession();
    const blob = await sealDmForMailbox({
      senderDid: session.did,
      senderPrivateKey: session.privateKey,
      recipientDid,
      envelope,
    });
    if (!blob) return; // oversized for the mailbox: P2P retry covers it
    await fetch(`${API()}/mailbox/deposit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        box: await mailboxIdForDid(recipientDid),
        blob: b64(blob),
      }),
    });
  } catch {
    // Relay down or box full: nothing lost, only slower.
  }
}

function authFields(): { did: string; ts: number; sig: string } {
  const session = requireSession();
  const ts = Math.floor(Date.now() / 1000);
  const sig = ed25519.sign(
    new TextEncoder().encode(`awful-mailbox:${ts}`),
    session.privateKey
  );
  return { did: session.did, ts, sig: b64(sig) };
}

let _collecting = false;

/** Fetch, verify, deliver and ack everything waiting for us. */
export async function collectMailbox(): Promise<void> {
  if (!mailboxPrefs.enabled || !API() || !isUnlocked() || _collecting) return;
  _collecting = true;
  try {
    const session = requireSession();
    const res = await fetch(`${API()}/mailbox/collect`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(authFields()),
    });
    if (!res.ok) return;
    const entries = (await res.json()) as Array<{ id: string; blob: string }>;
    if (!Array.isArray(entries) || entries.length === 0) return;

    const done: string[] = [];
    for (const entry of entries) {
      // Decrypt/parse failures are POISON: deterministic, ack them away so
      // they stop rotting in the box. Delivery failures are TRANSIENT (the
      // classic one: the identity locked mid-drain, so the storage write
      // threw) - the blob must stay in the box for the next tick, because
      // an ack deletes the only copy.
      let job: { senderDid: string; payload: unknown } | null = null;
      try {
        const { senderDid, envelope } = await openDmFromMailbox({
          blob: unb64(entry.blob),
          selfDid: session.did,
          selfPrivateKey: session.privateKey,
        });
        const parsed = parseDmEnvelope(envelope);
        if (parsed?.type === "chat")
          job = { senderDid, payload: parsed.payload };
      } catch (err) {
        console.warn("[mailbox] dropped blob:", err);
        done.push(entry.id);
        continue;
      }
      try {
        if (job)
          await deliverMailboxDm(
            job.senderDid,
            job.payload as Parameters<typeof deliverMailboxDm>[1]
          );
        done.push(entry.id);
      } catch (err) {
        console.warn("[mailbox] delivery failed, keeping blob:", err);
      }
    }
    if (done.length > 0) {
      await fetch(`${API()}/mailbox/ack`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...authFields(), ids: done }),
      });
      console.log(`[mailbox] collected ${done.length} offline DM(s)`);
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
