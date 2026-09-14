/**
 * remembered-password.ts - encrypted-at-rest "remember my password".
 *
 * Replaces the old plaintext `awful_password` cookie. The password is
 * AES-GCM encrypted under a NON-EXTRACTABLE CryptoKey that lives only in
 * IndexedDB: it never travels with requests, can't be read via
 * document.cookie, and the key bytes can't be exfiltrated even by code
 * running in the origin. (Code running in the origin can still *use* the
 * key - that's the inherent ceiling of any client-only secret storage;
 * use the WebAuthn/biometric unlock for a hardware-backed alternative.)
 */

import { openDB, type IDBPDatabase } from "idb";

interface RememberedRecord {
  id: "remembered";
  key: CryptoKey; // non-extractable AES-GCM key (structured-cloned into IDB)
  iv: Uint8Array<ArrayBuffer>;
  ct: ArrayBuffer;
  expires: number; // epoch ms
}

type AuthDB = IDBPDatabase<{
  auth: { key: string; value: RememberedRecord };
}>;

const LEGACY_COOKIE = "awful_password";

async function authDb(): Promise<AuthDB> {
  return (await openDB("awful-auth", 1, {
    upgrade(db) {
      db.createObjectStore("auth", { keyPath: "id" });
    },
  })) as AuthDB;
}

/** Read-and-delete the old plaintext cookie (migration source). */
function takeLegacyCookie(): string | null {
  if (typeof document === "undefined") return null;
  const match = document.cookie.match(
    new RegExp("(^| )" + LEGACY_COOKIE + "=([^;]+)")
  );
  document.cookie = `${LEGACY_COOKIE}=; max-age=0; path=/; SameSite=Strict`;
  return match ? decodeURIComponent(match[2]) : null;
}

export async function saveRememberedPassword(
  password: string,
  days: number
): Promise<void> {
  takeLegacyCookie();
  const { getWebAuthnRecord } = await import("../storage");
  if (await getWebAuthnRecord()) {
    await clearRememberedPassword();
    return;
  }
  const key = await crypto.subtle.generateKey(
    { name: "AES-GCM", length: 256 },
    false, // non-extractable
    ["encrypt", "decrypt"]
  );
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv },
    key,
    new TextEncoder().encode(password)
  );
  // days < 0 is the "remember until I log out" sentinel: no time-based expiry
  // (the record is cleared explicitly on logout). Without this, -1 computes a
  // timestamp in the past and the record is deleted on the very next read.
  const expires =
    days < 0 ? Number.MAX_SAFE_INTEGER : Date.now() + days * 86_400_000;
  const db = await authDb();
  await db.put("auth", {
    id: "remembered",
    key,
    iv,
    ct,
    expires,
  });
}

export async function loadRememberedPassword(): Promise<string | null> {
  // Enforce at the storage boundary, not just the unlock screen. Older builds
  // may have saved both credentials; those must never bypass user verification.
  const { getWebAuthnRecord } = await import("../storage");
  if (await getWebAuthnRecord()) {
    await clearRememberedPassword();
    return null;
  }
  // Migrate a pre-existing plaintext-cookie password into the encrypted
  // store so users who had "remember me" enabled keep their auto-unlock.
  const legacy = takeLegacyCookie();
  if (legacy) {
    await saveRememberedPassword(legacy, 15).catch(() => {});
    return legacy;
  }
  try {
    const db = await authDb();
    const rec = await db.get("auth", "remembered");
    if (!rec) return null;
    if (rec.expires < Date.now()) {
      await db.delete("auth", "remembered");
      return null;
    }
    const pt = await crypto.subtle.decrypt(
      { name: "AES-GCM", iv: rec.iv },
      rec.key,
      rec.ct
    );
    return new TextDecoder().decode(pt);
  } catch {
    return null;
  }
}

export async function clearRememberedPassword(): Promise<void> {
  takeLegacyCookie();
  try {
    const db = await authDb();
    await db.delete("auth", "remembered");
  } catch {}
}
