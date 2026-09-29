import { expect, it } from "vitest";
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
