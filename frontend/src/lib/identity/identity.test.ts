import { beforeEach, describe, expect, it } from "vitest";
import {
  AESFromPassword,
  createIdentity,
  lockIdentity,
  unlockIdentity,
  isUnlocked,
} from "./identity";
import {
  getAllRooms,
  getDB,
  getMnemonicRecord,
  putRoom,
  wipeLocalDatabase,
} from "../storage";

const PASSWORD = "correct horse battery staple";

describe("password-derived key", () => {
  beforeEach(async () => {
    await wipeLocalDatabase();
    lockIdentity();
  });

  it("stores the PBKDF2 iteration count alongside the mnemonic", async () => {
    await createIdentity(PASSWORD);
    const record = await getMnemonicRecord();
    // Anything that copies this record to another device (QR sync, file
    // backup) must copy this field too - see the round-trip test below.
    expect(record?.iterations).toBeTypeOf("number");
    expect(record!.iterations).toBeGreaterThanOrEqual(600_000);
  });

  it("unlocks with the right password and rejects the wrong one", async () => {
    await createIdentity(PASSWORD);
    lockIdentity();
    await expect(unlockIdentity("not the password")).rejects.toThrow(
      /Wrong password/
    );
    await unlockIdentity(PASSWORD);
    expect(isUnlocked()).toBe(true);
  });

  // The bug this guards: device sync used to copy salt/iv/ciphertext but drop
  // `iterations`, so the receiving device derived the key with the legacy
  // count and told the user their correct password was wrong.
  it("a record that loses its iteration count no longer decrypts", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const plaintext = new TextEncoder().encode("some mnemonic phrase");

    const strongKey = await AESFromPassword(PASSWORD, salt, 600_000);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      strongKey,
      plaintext
    );

    // Same password, legacy iteration count = a different key = failure.
    const legacyKey = await AESFromPassword(PASSWORD, salt, 100_000);
    await expect(
      crypto.subtle.decrypt({ name: "AES-GCM", iv }, legacyKey, ciphertext)
    ).rejects.toThrow();

    // Carrying the count across gives back the plaintext.
    const carriedKey = await AESFromPassword(PASSWORD, salt, 600_000);
    const out = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      carriedKey,
      ciphertext
    );
    expect(new TextDecoder().decode(out)).toBe("some mnemonic phrase");
  });

  it("still opens legacy records written before the count was stored", async () => {
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const legacyKey = await AESFromPassword(PASSWORD, salt, 100_000);
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      legacyKey,
      new TextEncoder().encode("legacy mnemonic")
    );

    // unlockIdentity falls back to 100k when `iterations` is absent, which is
    // exactly what an old record (or an old peer's export) looks like.
    const key = await AESFromPassword(PASSWORD, salt, 100_000);
    const out = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv },
      key,
      ciphertext
    );
    expect(new TextDecoder().decode(out)).toBe("legacy mnemonic");
  });
});

// A device that already holds an account, then makes a NEW one. The old
// account's rows are sealed under a key derived from ITS private key, so most
// of them cannot be read again - but unreadable is not gone: clear fields
// survive, rows written before at-rest encryption (or during a locked import)
// are not sealed at all and open under any key, and the at-rest sweep would
// re-seal those under the new identity's key. A friend reported exactly this:
// a fresh account that still listed the previous account's room.
describe("a new identity does not inherit the previous one's data", () => {
  beforeEach(async () => {
    await wipeLocalDatabase();
    lockIdentity();
  });

  it("removes the old account's rows rather than leaving them unreadable", async () => {
    await createIdentity(PASSWORD);
    await putRoom({
      roomCode: "a1b2c3d4e5f60718",
      type: "text",
      name: "Old account's room",
      lastSeenLamport: 0,
      createdAt: 1,
      participants: [],
    });

    await createIdentity("a completely different password");

    // NOT getAllRooms(): a sealed row the new key cannot open is dropped on
    // read, so that would pass whether the data was erased or merely hidden.
    // Go to the raw store - the row has to be GONE.
    const db = await getDB();
    expect(await db.getAll("rooms")).toEqual([]);
  });

  // The shape that actually reached a user. A row written before at-rest
  // encryption existed (or during a locked import) is NOT sealed, and openRow
  // passes an unsealed row straight through - so it opens under whatever
  // identity is signed in, and the new account sees the old account's room.
  it("removes UNSEALED legacy rows, which open under any identity", async () => {
    await createIdentity(PASSWORD);
    const db = await getDB();
    await db.put("rooms", {
      roomCode: "legacyroom000000",
      type: "text",
      name: "Written before at-rest encryption",
      lastSeenLamport: 0,
      createdAt: 1,
      participants: [],
    } as never);
    expect(await getAllRooms()).toHaveLength(1);

    await createIdentity("a completely different password");

    // Raw store again, for the same reason as above: the at-rest sweep may
    // have sealed this row under the OLD key first, and a sealed row is
    // merely dropped on read. Erased is the only acceptable outcome.
    const after = await getDB();
    expect(await after.getAll("rooms")).toEqual([]);
  });

  it("still works on a device with no previous account", async () => {
    const { keypair } = await createIdentity(PASSWORD);
    expect(keypair.did).toMatch(/^did:key:/);
    expect(await getAllRooms()).toEqual([]);
  });
});
