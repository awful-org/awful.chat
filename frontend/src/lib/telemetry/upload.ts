/**
 * Upload a bundle to this instance's collector.
 *
 * The collector is the relay the app already talks to, so there is NO new
 * runtime-config key. Without `TELEMETRY_ENABLED=1` the relay answers 204 and
 * nothing happens; that answer is memoized and the Upload button is hidden.
 *
 * AUTH: signed with the DEVICE libp2p key, never the identity key.
 * The peerId of an Ed25519 libp2p key is an identity multihash - the public key
 * is INSIDE it - so a signature checked against the key extracted from the
 * claimed peerId proves the uploader owns that peerId, and the relay already
 * knows every peerId it has seen. A signature by the identity key would instead
 * hand the collector a `did:key` -> peerId binding it must never learn.
 */

import { keys } from "@libp2p/crypto";
import { sha256 } from "@noble/hashes/sha2.js";
import { apiUrl } from "../runtime-config";
import { deviceKeySeed } from "../transport/device-key";
import { trimBundleForUpload } from "./bundle";
import { diagPrefs } from "./prefs.svelte";
import type { ClientBundle } from "./schema";

/**
 * Headroom under the relay's `telemetryMaxBody` (2 MiB). `JSON.stringify`
 * length counts characters, and a multi-byte character costs more than one
 * byte, so the trim target must sit below the real limit.
 */
export const UPLOAD_MAX_CHARS = 1_800_000;

/** Mandatory domain separation. Reusing the mailbox prefix would make one
 *  signature valid on both surfaces. */
const SIGN_PREFIX = "awful-telemetry:";

export type UploadResult =
  | { ok: true; bundleId: string }
  | {
      ok: false;
      reason:
        | "disabled"
        | "off"
        | "too-large"
        | "unauthorized"
        | "rate-limited"
        | "network";
    };

/** Memoized: 204 means the operator never set the collector up. */
let collectorKnown: boolean | null = null;

export function resetUploadStateForTest(): void {
  collectorKnown = null;
}

/**
 * The exact string that is signed. Exported so the relay's own test and this
 * module cannot drift apart silently.
 */
export function signedContent(ts: number, bodySha256Hex: string): string {
  return `${SIGN_PREFIX}${ts}:${bodySha256Hex}`;
}

export function hexSha256(body: string): string {
  const digest = sha256(new TextEncoder().encode(body));
  return [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Send a bundle. Never throws; every failure is a `reason` plus one warning.
 */
export async function uploadBundle(b: ClientBundle): Promise<UploadResult> {
  if (!diagPrefs.upload) return { ok: false, reason: "off" };

  const base = apiUrl();
  if (!base) return { ok: false, reason: "disabled" };

  try {
    const trimmed = trimBundleForUpload(b, UPLOAD_MAX_CHARS);
    const body = JSON.stringify(trimmed);
    if (body.length > UPLOAD_MAX_CHARS) return { ok: false, reason: "too-large" };

    const ts = Date.now();
    const digest = hexSha256(body);
    const key = await keys.generateKeyPairFromSeed("Ed25519", deviceKeySeed());
    const sig = await key.sign(new TextEncoder().encode(signedContent(ts, digest)));

    const res = await fetch(`${base}/telemetry`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-awful-peer": b.self.peerId,
        "x-awful-ts": String(ts),
        "x-awful-sig": base64(sig),
      },
      body,
    });

    if (res.status === 204) {
      collectorKnown = false;
      return { ok: false, reason: "disabled" };
    }
    collectorKnown = true;
    if (res.status === 401 || res.status === 403) {
      return { ok: false, reason: "unauthorized" };
    }
    if (res.status === 429) return { ok: false, reason: "rate-limited" };
    // The relay answers 413 once the body passed `telemetryMaxBody`, which
    // means the trim above left too little headroom.
    if (res.status === 413) return { ok: false, reason: "too-large" };
    if (!res.ok) {
      console.warn("[diag] upload failed:", res.status);
      return { ok: false, reason: "network" };
    }

    const parsed = (await res.json()) as { bundleId?: unknown };
    return typeof parsed.bundleId === "string"
      ? { ok: true, bundleId: parsed.bundleId }
      : { ok: false, reason: "network" };
  } catch (err) {
    console.warn("[diag] upload failed:", err);
    return { ok: false, reason: "network" };
  }
}

/**
 * Whether the collector exists. A HEAD is not used: the ingest route is
 * POST-only, so an empty POST is the only probe, and the relay meters it.
 */
export async function collectorAvailable(): Promise<boolean> {
  if (collectorKnown !== null) return collectorKnown;
  const base = apiUrl();
  if (!base) {
    collectorKnown = false;
    return false;
  }
  try {
    const res = await fetch(`${base}/telemetry`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    // 204 is "not set up". Anything else - including a 400 or a 401 - means the
    // route is live and only the request was wrong.
    collectorKnown = res.status !== 204;
    return collectorKnown;
  } catch {
    // A network failure says nothing about the operator's configuration, so it
    // is NOT memoized.
    return false;
  }
}

function base64(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += String.fromCharCode(b);
  return btoa(out);
}
