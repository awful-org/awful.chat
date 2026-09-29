import * as opaque from "@serenity-kit/opaque";
import { base64urlnopad as base64url } from "@scure/base";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { parseRoomSecret, type RoomSecret } from "./keys";

export const PAIRING_TTL = 300_000;
export const PAIRING_ATTEMPTS = 5;
const alphabet = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const enc = new TextEncoder();
export function pairingRandom(length: number): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(length)), b => alphabet[b & 31]).join("");
}
export function parsePairingCode(input: string): { locator: string; password: string } | null {
  const raw = input.trim().toUpperCase().replace(/[-\s]/g, "").replace(/O/g, "0").replace(/[IL]/g, "1");
  if (!/^[0-9A-HJKMNP-TV-Z]{16}$/.test(raw)) return null;
  return { locator: raw.slice(0, 8), password: raw.slice(8) };
}
export function formatPairingCode(locator: string, password: string): string {
  return `${locator.slice(0, 4)}-${locator.slice(4)} ${password.slice(0, 4)}-${password.slice(4)}`;
}
const identifiers = (locator: string) => ({ client: `awful/pairing/v2/joiner/${locator}`, server: `awful/pairing/v2/inviter/${locator}` });
function message(value: string): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,2048}$/.test(value)) throw new Error("Invalid pairing message");
  return value;
}
async function transferKey(sessionKey: string, locator: string, attempt: string): Promise<CryptoKey> {
  const key = hkdf(sha256, enc.encode(sessionKey), enc.encode(locator), enc.encode(`awful/pairing/v2/transfer/${attempt}`), 32);
  try { return await crypto.subtle.importKey("raw", new Uint8Array(key), "AES-GCM", false, ["encrypt", "decrypt"]); }
  finally { key.fill(0); }
}
function aad(locator: string, attempt: string): Uint8Array<ArrayBuffer> {
  return enc.encode(JSON.stringify(["awful/pairing/v2", locator, attempt]));
}

/** OPAQUE's server is the inviter, never the relay. Registration stays local. */
export class InvitationPairingHost {
  readonly locator = pairingRandom(8);
  readonly password = pairingRandom(8);
  readonly expiresAt: number;
  private setup = "";
  private record = "";
  private secret: RoomSecret | null;
  private attempts = 0;
  private pending = new Map<string, string>();
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
    this.pending.clear();
  }
  start(attempt: string, request: string): string {
    if (!this.active || this.attempts >= PAIRING_ATTEMPTS) throw new Error("Pairing expired or attempt limit reached");
    this.attempts++;
    message(attempt);
    if (this.pending.has(attempt)) throw new Error("Repeated pairing attempt");
    const result = opaque.server.startLogin({ serverSetup: this.setup, registrationRecord: this.record, userIdentifier: this.locator, startLoginRequest: message(request), identifiers: identifiers(this.locator) });
    this.pending.set(attempt, result.serverLoginState);
    return result.loginResponse;
  }
  async finish(attempt: string, request: string): Promise<string> {
    if (!this.active) throw new Error("Pairing expired");
    const state = this.pending.get(attempt);
    this.pending.delete(attempt); // Every proof gets exactly one verification.
    if (!state) throw new Error("Unknown pairing attempt");
    const { sessionKey } = opaque.server.finishLogin({ serverLoginState: state, finishLoginRequest: message(request) });
    const secret = this.secret!;
    this.cancel(); // Consume BEFORE asynchronous encryption or relay delivery.
    const key = await transferKey(sessionKey, this.locator, attempt);
    const nonce = crypto.getRandomValues(new Uint8Array(12));
    const ciphertext = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: aad(this.locator, attempt) }, key, enc.encode(secret));
    return `${base64url.encode(nonce)}.${base64url.encode(new Uint8Array(ciphertext))}`;
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
  let responded = false;
  let consumed = false;
  return {
    locator, attempt, request: login.startLoginRequest,
    respond(response: string): string {
      if (responded) throw new Error("Pairing response already consumed");
      responded = true;
      const result = opaque.client.finishLogin({ ...login, password, loginResponse: message(response), identifiers: identifiers(locator) });
      if (!result) throw new Error("Incorrect or expired pairing code");
      sessionKey = result.sessionKey;
      return result.finishLoginRequest;
    },
    async open(payload: string): Promise<RoomSecret> {
      if (!sessionKey || consumed || payload.length > 512) throw new Error("Invalid pairing transfer");
      consumed = true;
      const parts = payload.split(".");
      if (parts.length !== 2) throw new Error("Invalid pairing transfer");
      const nonce = base64url.decode(parts[0]);
      if (nonce.length !== 12) throw new Error("Invalid pairing nonce");
      const key = await transferKey(sessionKey, locator, attempt);
      sessionKey = "";
      const plaintext = await crypto.subtle.decrypt({ name: "AES-GCM", iv: new Uint8Array(nonce), additionalData: aad(locator, attempt) }, key, new Uint8Array(base64url.decode(parts[1])));
      return parseRoomSecret(new TextDecoder("utf-8", { fatal: true }).decode(plaintext));
    },
  };
}
