import { expect, it } from "vitest";
import * as opaque from "@serenity-kit/opaque";
import { hkdf } from "@noble/hashes/hkdf.js";
import { sha256 } from "@noble/hashes/sha2.js";
import { ml_kem768 } from "@noble/post-quantum/ml-kem.js";
import { base64urlnopad } from "@scure/base";
import { newRoomSecret } from "./keys";
import { InvitationPairingHost, startPairingJoin, formatPairingCode, PAIRING_ATTEMPTS, PAIRING_TTL } from "./invitation-pairing";

async function prepared() {
  const secret = newRoomSecret();
  const host = await InvitationPairingHost.create(secret);
  const join = await startPairingJoin(formatPairingCode(host.locator, host.password));
  const proof = join.respond(host.start(join.attempt, join.request));
  return { secret, host, join, proof };
}

it("transfers the capability only after mutual PAKE verification, once", async () => {
  const { secret, host, join, proof } = await prepared();
  const payload = await host.finish(join.attempt, proof);
  expect(payload).not.toContain(secret);
  expect(await join.open(payload)).toBe(secret);
  expect(host.active).toBe(false);
  await expect(host.finish(join.attempt, proof)).rejects.toThrow();
  await expect(join.open(payload)).rejects.toThrow();
});

it("rejects a wrong password and caps attempts at the inviter", async () => {
  const host = await InvitationPairingHost.create(newRoomSecret());
  const wrong = (host.password[0] === "0" ? "1" : "0") + host.password.slice(1);
  for (let i = 0; i < PAIRING_ATTEMPTS; i++) {
    const join = await startPairingJoin(formatPairingCode(host.locator, wrong));
    const response = host.start(join.attempt, join.request);
    expect(() => join.respond(response)).toThrow();
  }
  const join = await startPairingJoin(formatPairingCode(host.locator, host.password));
  expect(() => host.start(join.attempt, join.request)).toThrow("limit");
});

it("rejects expired and cancelled invitations, including pending proofs", async () => {
  let now = 0;
  const expired = await InvitationPairingHost.create(newRoomSecret(), () => now);
  const join = await startPairingJoin(formatPairingCode(expired.locator, expired.password));
  now = PAIRING_TTL;
  expect(() => expired.start(join.attempt, join.request)).toThrow("expired");
  const { host, join: pending, proof } = await prepared();
  host.cancel();
  await expect(host.finish(pending.attempt, proof)).rejects.toThrow();
});

it("rejects a tampered encrypted transfer", async () => {
  const { host, join, proof } = await prepared();
  const payload = await host.finish(join.attempt, proof);
  const [nonce, ciphertext] = payload.split(".");
  const changed = (ciphertext[0] === "A" ? "B" : "A") + ciphertext.slice(1);
  await expect(join.open(`${nonce}.${changed}`)).rejects.toThrow();
});

it("binds encrypted transfers to their PAKE session and attempt", async () => {
  const first = await prepared();
  const second = await prepared();
  const payload = await first.host.finish(first.join.attempt, first.proof);
  await expect(second.join.open(payload)).rejects.toThrow();
});

// ── Post-quantum transfer (v3) ─────────────────────────────────────────────

it("sends an ML-KEM key with the response and fits the relay's 2048 limit", async () => {
  const host = await InvitationPairingHost.create(newRoomSecret());
  const join = await startPairingJoin(formatPairingCode(host.locator, host.password));
  const response = host.start(join.attempt, join.request);
  expect(response.split(".")).toHaveLength(2);
  expect(response.length).toBeLessThanOrEqual(2048);
  const finish = join.respond(response);
  expect(finish.split(".")).toHaveLength(3);
  expect(finish.length).toBeLessThanOrEqual(2048);
  expect(response).toMatch(/^[A-Za-z0-9_.-]+$/);
  expect(finish).toMatch(/^[A-Za-z0-9_.-]+$/);
});

it("refuses a stripped key instead of downgrading: a relay cannot force the classic transfer", async () => {
  const host = await InvitationPairingHost.create(newRoomSecret());
  const join = await startPairingJoin(formatPairingCode(host.locator, host.password));
  const [opaqueOnly] = host.start(join.attempt, join.request).split(".");
  // The joiner now believes it met an older host and answers the classic way.
  const classicFinish = join.respond(opaqueOnly);
  expect(classicFinish.split(".")).toHaveLength(1);
  await expect(host.finish(join.attempt, classicFinish)).rejects.toThrow("up-to-date");
});

it("refuses a swapped ML-KEM key before sending anything", async () => {
  const host = await InvitationPairingHost.create(newRoomSecret());
  const join = await startPairingJoin(formatPairingCode(host.locator, host.password));
  const [opaqueResponse] = host.start(join.attempt, join.request).split(".");
  const relayKey = ml_kem768.keygen().publicKey;
  const finish = join.respond(`${opaqueResponse}.${base64urlnopad.encode(relayKey)}`);
  await expect(host.finish(join.attempt, finish)).rejects.toThrow("mismatch");
});

it("refuses a replaced ciphertext or confirmation", async () => {
  for (const part of [1, 2]) {
    const { host, join, proof } = await prepared();
    const parts = proof.split(".");
    parts[part] = (parts[part][0] === "A" ? "B" : "A") + parts[part].slice(1);
    await expect(host.finish(join.attempt, parts.join("."))).rejects.toThrow();
  }
});

it("still pairs a new joiner with an older host, the classic way", async () => {
  // The pre-v3 host, as it was: OPAQUE only, and the transfer under the
  // session key alone.
  await opaque.ready;
  const enc = new TextEncoder();
  const secret = newRoomSecret();
  const locator = "k5", password = "t8r5";
  const ids = { client: `awful/pairing/v2/joiner/${locator}`, server: `awful/pairing/v2/inviter/${locator}` };
  const setup = opaque.server.createSetup();
  const reg = opaque.client.startRegistration({ password });
  const regResponse = opaque.server.createRegistrationResponse({ serverSetup: setup, userIdentifier: locator, registrationRequest: reg.registrationRequest });
  const record = opaque.client.finishRegistration({ ...reg, ...regResponse, password, identifiers: ids }).registrationRecord;

  const join = await startPairingJoin(formatPairingCode(locator, password));
  const start = opaque.server.startLogin({ serverSetup: setup, registrationRecord: record, userIdentifier: locator, startLoginRequest: join.request, identifiers: ids });
  const finish = join.respond(start.loginResponse);
  expect(finish.split(".")).toHaveLength(1);
  const { sessionKey } = opaque.server.finishLogin({ serverLoginState: start.serverLoginState, finishLoginRequest: finish });
  const raw = hkdf(sha256, enc.encode(sessionKey), enc.encode(locator), enc.encode(`awful/pairing/v2/transfer/${join.attempt}`), 32);
  const key = await crypto.subtle.importKey("raw", new Uint8Array(raw), "AES-GCM", false, ["encrypt"]);
  const nonce = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData: enc.encode(JSON.stringify(["awful/pairing/v2", locator, join.attempt])) }, key, enc.encode(secret));
  expect(await join.open(`${base64urlnopad.encode(nonce)}.${base64urlnopad.encode(new Uint8Array(ct))}`)).toBe(secret);
});
