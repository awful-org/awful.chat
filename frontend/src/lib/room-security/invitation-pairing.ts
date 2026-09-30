import * as opaque from "@serenity-kit/opaque";
import { base64urlnopad as base64url } from "@scure/base";
import { hkdf } from "@noble/hashes/hkdf.js";
import { hmac } from "@noble/hashes/hmac.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { parseRoomSecret, type RoomSecret } from "./keys";

export const PAIRING_TTL = 300_000;
export const PAIRING_ATTEMPTS = 5;
/**
 * The code is SHORT on purpose - six characters a person reads out or types
 * - because OPAQUE lets its password be: nothing about it can be tested
 * offline, only by a live attempt against the inviter, at most
 * PAIRING_ATTEMPTS per code and only for PAIRING_TTL. Four characters of
 * password is 2^20 possibilities, so a guesser's odds per code are 5 in
 * ~1M. The two-character locator only finds the pairing at the relay; it
 * is not secret, and a collision there is answered 409 and retried with a
 * fresh one (invite-pairing.ts).
 *
 * Lowercase Crockford base32: no i, l, o or u to confuse, and typed input
 * folds those to 1 and 0, in any case.
 */
export const PAIRING_LOCATOR_LENGTH = 2;
export const PAIRING_PASSWORD_LENGTH = 4;
const alphabet = "0123456789abcdefghjkmnpqrstvwxyz";
const enc = new TextEncoder();
export function pairingRandom(length: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), b => alphabet[b & 31]).join("");
}
export function parsePairingCode(input: string): { locator: string; password: string } | null {
  const raw = input.trim().toLowerCase().replace(/[-\s]/g, "").replace(/o/g, "0").replace(/[il]/g, "1");
  const length = PAIRING_LOCATOR_LENGTH + PAIRING_PASSWORD_LENGTH;
  if (raw.length !== length || !/^[0-9a-hjkmnp-tv-z]+$/.test(raw)) return null;
  return { locator: raw.slice(0, PAIRING_LOCATOR_LENGTH), password: raw.slice(PAIRING_LOCATOR_LENGTH) };
}
/** Shown as two groups of three - "k5t-8r5" - whatever the split. */
export function formatPairingCode(locator: string, password: string): string {
  const code = locator + password;
  return `${code.slice(0, 3)}-${code.slice(3)}`;
}
const identifiers = (locator: string) => ({ client: `awful/pairing/v2/joiner/${locator}`, server: `awful/pairing/v2/inviter/${locator}` });
function message(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw new Error("Invalid pairing message");
  return value;
}
function aad(locator: string, attempt: string): Uint8Array<ArrayBuffer> {
  return enc.encode(JSON.stringify(["awful/pairing/v2", locator, attempt]));
}

/*
 * Post-quantum transfer ("v3"). OPAQUE proves both sides know the code and
 * agrees a session key - on elliptic curves, so a relay that records a
 * pairing today could compute that key with a quantum computer later and
 * read the room secret it carried. The transfer key therefore also takes an
 * ML-KEM-768 secret, and holds while EITHER half does. The code itself does
 * not change: its strength is the live attempt limit, which a quantum
 * computer does not lift.
 *
 *   response  host -> joiner  OPAQUE response "." the host's one-off ML-KEM key
 *   finish    joiner -> host  OPAQUE finish "." ML-KEM ciphertext "." confirmation
 *   transfer  host -> joiner  the room secret, under a key from BOTH secrets
 *
 * The confirmation is an HMAC under the OPAQUE session key over the ML-KEM
 * key the joiner saw and the ciphertext it sent. A relay that swapped the
 * key cannot make one (it would need the code), and the host sends nothing
 * unless it verifies - otherwise it could ship the secret under a key the
 * relay helped choose and could open with a quantum computer later.
 *
 * Compatibility: a new joiner meeting an old host (a response with no key)
 * pairs the old way. A new host requires the hybrid finish, so a relay that
 * strips its key breaks the pairing instead of downgrading it; an old joiner
 * cannot read the new response at all and has to update. The relay is
 * unchanged: the largest payload, the response, is 2007 characters of its
 * 2048.
 */
const KEM_KEY_BYTES = 1184;
const KEM_CT_BYTES = 1088;
const TAG_BYTES = 32;

/** Canonical base64url of exactly `bytes` bytes, or a throw. */
function exactB64(text: string, bytes: number): Uint8Array {
  if (typeof text !== "string" || text.length !== Math.ceil((bytes * 4) / 3) || !/^[A-Za-z0-9_-]+$/.test(text)) {
    throw new Error("Invalid pairing message");
  }
  const decoded = base64url.decode(text);
  if (decoded.length !== bytes || base64url.encode(decoded) !== text) throw new Error("Invalid pairing message");
  return decoded;
}

function hashed(bytes: Uint8Array): string {
  return base64url.encode(sha256(bytes));
}

/** The pre-v3 transfer key: the OPAQUE session key alone. */
async function classicTransferKey(sessionKey: string, locator: string, attempt: string): Promise<CryptoKey> {
  const session = enc.encode(sessionKey);
  const key = hkdf(sha256, session, enc.encode(locator), enc.encode(`awful/pairing/v2/transfer/${attempt}`), 32);
  session.fill(0);
  try { return await crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, ["encrypt", "decrypt"]); }
  finally { key.fill(0); }
}

/** Both secrets, with every public input bound in, so no half can be swapped. */
async function hybridTransferKey(sessionKey: string, kemShared: Uint8Array, locator: string, attempt: string,
  ek: Uint8Array, ct: Uint8Array): Promise<CryptoKey> {
  const session = enc.encode(sessionKey);
  const ikm = new Uint8Array(session.length + kemShared.length);
  ikm.set(session, 0);
  ikm.set(kemShared, session.length);
  const info = enc.encode(JSON.stringify([`awful/pairing/v3/transfer/${attempt}`, hashed(ek), hashed(ct)]));
  const key = hkdf(sha256, ikm, enc.encode(locator), info, 32);
  ikm.fill(0);
  session.fill(0);
  try { return await crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, ["encrypt", "decrypt"]); }
  finally { key.fill(0); }
}

/** The joiner's proof that it used THIS host key, under the OPAQUE session key. */
function confirmation(sessionKey: string, locator: string, attempt: string, ek: Uint8Array, ct: Uint8Array): string {
  const session = enc.encode(sessionKey);
  const key = hkdf(sha256, session, enc.encode(locator), enc.encode(`awful/pairing/v3/confirm/${attempt}`), 32);
  session.fill(0);
  try {
    return base64url.encode(hmac(sha256, key, enc.encode(JSON.stringify(["awful/pairing/v3/confirm", hashed(ek), hashed(ct)]))));
  } finally { key.fill(0); }
}

function sameTag(expected: string, received: string): boolean {
  if (expected.length !== received.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ received.charCodeAt(i);
  return diff === 0;
}

/** OPAQUE's server is the inviter, never the relay. Registration stays local. */
export class InvitationPairingHost {
  readonly locator = pairingRandom(PAIRING_LOCATOR_LENGTH);
  readonly password = pairingRandom(PAIRING_PASSWORD_LENGTH);
  readonly expiresAt: number;
  private setup = "";
  private record = "";
  private secret: RoomSecret | null;
  private attempts = 0;
  /** Per attempt: the OPAQUE login state and its one-off ML-KEM keypair. */
  private pending = new Map<string, { login: string; kem: { publicKey: Uint8Array; secretKey: Uint8Array } }>();
  private closed = false;
  private constructor(secret: RoomSecret, private clock: () => number) {
    this.secret = parseRoomSecret(secret);
    this.expiresAt = clock() + PAIRING_TTL;
  }
  static async create(secret: RoomSecret, clock = Date.now): Promise<InvitationPairingHost> {
    await opaque.ready;
    const host = new InvitationPairingHost(secret, clock);
    host.setup = opaque.server.createSetup();
    const registration = opaque.client.startRegistration({ password: host.password });
    const response = opaque.server.createRegistrationResponse({ serverSetup: host.setup, userIdentifier: host.locator, registrationRequest: registration.registrationRequest });
    host.record = opaque.client.finishRegistration({ ...registration, ...response, password: host.password, identifiers: identifiers(host.locator) }).registrationRecord;
    return host;
  }
  get active(): boolean { return !this.closed && this.clock() < this.expiresAt; }
  cancel(): void {
    this.closed = true;
    this.secret = null;
    this.setup = this.record = "";
    for (const { kem } of this.pending.values()) kem.secretKey.fill(0);
    this.pending.clear();
  }
  start(attempt: string, request: string): string {
    if (!this.active || this.attempts >= PAIRING_ATTEMPTS) throw new Error("Pairing expired or attempt limit reached");
    this.attempts++;
    message(attempt);
    if (this.pending.has(attempt)) throw new Error("Repeated pairing attempt");
    const result = opaque.server.startLogin({ serverSetup: this.setup, registrationRecord: this.record, userIdentifier: this.locator, startLoginRequest: message(request), identifiers: identifiers(this.locator) });
    // A fresh ML-KEM key per attempt, never reused.
    const kem = ml_kem768.keygen();
    this.pending.set(attempt, { login: result.serverLoginState, kem });
    return `${result.loginResponse}.${base64url.encode(kem.publicKey)}`;
  }
  async finish(attempt: string, request: string): Promise<string> {
    if (!this.active) throw new Error("Pairing expired");
    const state = this.pending.get(attempt);
    this.pending.delete(attempt); // Every proof gets exactly one verification.
    if (!state) throw new Error("Unknown pairing attempt");
    try {
      // Only the hybrid finish: a plain one comes from an old joiner, which
      // could not have read our response, or from a relay that stripped our
      // key - and a downgrade is what this refuses.
      const parts = typeof request === "string" ? request.split(".") : [];
      if (parts.length !== 3) throw new Error("Pairing needs an up-to-date app on both sides");
      const ct = exactB64(parts[1], KEM_CT_BYTES);
      exactB64(parts[2], TAG_BYTES);
      const { sessionKey } = opaque.server.finishLogin({ serverLoginState: state.login, finishLoginRequest: message(parts[0]) });
      if (!sameTag(confirmation(sessionKey, this.locator, attempt, state.kem.publicKey, ct), parts[2])) {
        throw new Error("Pairing key mismatch");
      }
      const kemShared = ml_kem768.decapsulate(ct, state.kem.secretKey);
      const secret = this.secret!;
      this.cancel(); // Consume BEFORE asynchronous encryption or relay delivery.
      let key: CryptoKey;
      try { key = await hybridTransferKey(sessionKey, kemShared, this.locator, attempt, state.kem.publicKey, ct); }
      finally { kemShared.fill(0); }
      const nonce = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(this.locator, attempt) }, key, enc.encode(secret));
      return `${base64url.encode(nonce)}.${base64url.encode(new Uint8Array(ciphertext))}`;
    } finally {
      state.kem.secretKey.fill(0);
    }
  }
}

export async function startPairingJoin(code: string) {
  const parsed = parsePairingCode(code);
  if (!parsed) throw new Error("Enter the complete pairing code");
  await opaque.ready;
  const { locator, password } = parsed;
  const attempt = pairingRandom(32);
  const login = opaque.client.startLogin({ password });
  let sessionKey = "";
  // Set when the host sent an ML-KEM key (v3); absent for an older host.
  let hybrid: { ek: Uint8Array; ct: Uint8Array; shared: Uint8Array } | null = null;
  let responded = false;
  let consumed = false;
  return {
    locator, attempt, request: login.startLoginRequest,
    respond(response: string): string {
      if (responded) throw new Error("Pairing response already consumed");
      responded = true;
      const parts = typeof response === "string" ? response.split(".") : [];
      if (parts.length !== 1 && parts.length !== 2) throw new Error("Invalid pairing message");
      const result = opaque.client.finishLogin({ ...login, password, loginResponse: message(parts[0]), identifiers: identifiers(locator) });
      if (!result) throw new Error("Incorrect or expired pairing code");
      sessionKey = result.sessionKey;
      if (parts.length === 1) return result.finishLoginRequest; // An older host: the classic transfer.
      const ek = exactB64(parts[1], KEM_KEY_BYTES);
      // encapsulate() throws on a key that fails the FIPS 203 check.
      const { cipherText, sharedSecret } = ml_kem768.encapsulate(ek);
      hybrid = { ek, ct: cipherText, shared: sharedSecret };
      return `${result.finishLoginRequest}.${base64url.encode(cipherText)}.${confirmation(sessionKey, locator, attempt, ek, cipherText)}`;
    },
    async open(payload: string): Promise<RoomSecret> {
      if (!sessionKey || consumed || payload.length > 512) throw new Error("Invalid pairing transfer");
      consumed = true;
      const parts = payload.split(".");
      if (parts.length !== 2) throw new Error("Invalid pairing transfer");
      const nonce = base64url.decode(parts[0]);
      if (nonce.length !== 12) throw new Error("Invalid pairing nonce");
      let key: CryptoKey;
      try {
        key = hybrid
          ? await hybridTransferKey(sessionKey, hybrid.shared, locator, attempt, hybrid.ek, hybrid.ct)
          : await classicTransferKey(sessionKey, locator, attempt);
      } finally {
        sessionKey = "";
        hybrid?.shared.fill(0);
      }
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(nonce), additionalData: aad(locator, attempt) }, key, new Uint8Array(base64url.decode(parts[1])));
      return parseRoomSecret(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    },
    /** A pairing that ends without a transfer (aborted, timed out, refused)
     *  must not leave its ML-KEM secret in memory until collection. */
    dispose(): void {
      consumed = true;
      sessionKey = "";
      hybrid?.shared.fill(0);
    },
  };
}
