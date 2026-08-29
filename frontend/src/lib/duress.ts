/**
 * Duress password: entered at the unlock screen instead of the real
 * password, it wipes this device's data and lands on the fresh-install
 * screen - indistinguishable from a device that never had an account.
 *
 * What makes the wipe real is the at-rest layer (storage-crypto.ts): the
 * database only ever held AES-GCM ciphertext keyed off the identity, so
 * even the IndexedDB remnants LevelDB keeps around after deletion are
 * noise. The wipe here is cleanup plus removing the (password-encrypted)
 * mnemonic blob - the one artifact a forensic pass could try to attack,
 * and it still needs the REAL password.
 *
 * Only a salted PBKDF2 hash of the duress password is stored, in
 * localStorage - it must be checkable while the identity is LOCKED, and it
 * protects nothing (matching it triggers destruction, not access). The
 * identity's own password is never stored in any form, same as before.
 */

const DURESS_KEY = "awful:duress:v1";
// Same cost as the identity's PBKDF2 (identity.ts PBKDF2_ITERATIONS): a
// cheaper duress check would make unlock timing reveal that a duress record
// exists, and leave its hash 6x easier to brute-force than the real one.
const ITERATIONS = 600_000;

/** Every IndexedDB database this origin creates. The wipe must name them
 *  explicitly for engines without indexedDB.databases(): awful-auth holds
 *  the remembered REAL password, awful-share-target raw shared files,
 *  awful-notify typed notification replies and DM addressing - precisely
 *  what must not survive a wipe. Adding a database anywhere in the app
 *  means adding it HERE (duress.test.ts holds the list to that). */
export const KNOWN_DBS = [
  "awful-chat",
  "awful-auth",
  "awful-share-target",
  "awful-notify",
];

interface DuressRecord {
  salt: string; // base64
  hash: string; // base64 PBKDF2-SHA-256 output
  iterations: number;
}

const b64 = (buf: ArrayBuffer | Uint8Array): string =>
  btoa(String.fromCharCode(...new Uint8Array(buf)));
const unb64 = (s: string): Uint8Array<ArrayBuffer> =>
  Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

/**
 * XOR-accumulate over two equal-length byte arrays instead of returning on
 * the first mismatch, so comparison time does not depend on where the two
 * base64 strings first diverge. Length mismatch returns false immediately -
 * that leaks nothing a fixed-format PBKDF2 output (32 bytes) does not
 * already fix.
 *
 * Real threat boundary: this hash sits in localStorage, so anyone with
 * devtools access to this origin can already read the record directly and
 * does not need to time a comparison to learn anything. The only case this
 * protects is a scriptable caller driving unlock attempts without devtools
 * access to storage - e.g. a remote-control or automation surface calling
 * into this module - where timing the comparison would otherwise be the
 * only side channel available.
 */
function constantTimeEqual(a: string, b: string): boolean {
  const bytesA = unb64(a);
  const bytesB = unb64(b);
  if (bytesA.length !== bytesB.length) return false;
  let diff = 0;
  for (let i = 0; i < bytesA.length; i++) {
    diff |= bytesA[i] ^ bytesB[i];
  }
  return diff === 0;
}

async function derive(
  password: string,
  salt: Uint8Array<ArrayBuffer>,
  iterations: number
): Promise<string> {
  const base = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    { name: "PBKDF2" },
    false,
    ["deriveBits"]
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    base,
    256
  );
  return b64(bits);
}

function readRecord(): DuressRecord | null {
  try {
    const raw = localStorage.getItem(DURESS_KEY);
    if (!raw) return null;
    const rec = JSON.parse(raw) as DuressRecord;
    if (!rec.salt || !rec.hash || !rec.iterations) return null;
    return rec;
  } catch {
    return null;
  }
}

export function hasDuressPassword(): boolean {
  return readRecord() !== null;
}

export async function setDuressPassword(password: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  localStorage.setItem(
    DURESS_KEY,
    JSON.stringify({
      salt: b64(salt),
      hash,
      iterations: ITERATIONS,
    } satisfies DuressRecord)
  );
  // A remembered password auto-unlocks past the duress screen - the coerced
  // user would never get to type anything. The two features are mutually
  // exclusive on a device.
  try {
    const { clearRememberedPassword } = await import(
      "./identity/remembered-password"
    );
    await clearRememberedPassword();
  } catch {
    /* nothing remembered */
  }
}

export function clearDuressPassword(): void {
  try {
    localStorage.removeItem(DURESS_KEY);
  } catch {
    // Nothing stored, nothing to clear.
  }
}

/**
 * True when the entered password is the duress password.
 *
 * Exactly one PBKDF2 runs whether or not a duress password is configured.
 * Returning early on a missing record made an unlock attempt cost one
 * derivation on a device with no duress password and two on a device with
 * one - a difference of hundreds of milliseconds that a coercer holding the
 * device could measure with a stopwatch, learning the feature was armed
 * before the victim typed anything. The throwaway salt below is worth
 * nothing cryptographically; it is there to spend the same wall-clock time.
 *
 * Callers run this only AFTER a real unlock has failed (identity.svelte.ts):
 * that is where a duress password can land, and it keeps a successful unlock
 * at one derivation instead of two.
 */
export async function isDuressPassword(password: string): Promise<boolean> {
  const rec = readRecord();
  const salt = rec
    ? unb64(rec.salt)
    : crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, rec?.iterations ?? ITERATIONS);
  if (!rec) return false;
  // Constant-time comparison - see constantTimeEqual's doc comment for the
  // actual threat boundary this addresses (it is narrower than it looks:
  // both sides are PBKDF2 outputs, and a "match" grants destruction, not
  // access).
  return constantTimeEqual(hash, rec.hash);
}

/**
 * Destroy this device's data: every IndexedDB database (identity, messages,
 * files - all of it), web storage, and every Cache Storage bucket, then
 * reload into the fresh-install flow. Strictly local and silent: no network
 * writes, no room leaves - outbound traffic at wipe time is itself a tell.
 * Never returns.
 */
export async function executeDuressWipe(): Promise<never> {
  // Web storage first: even if a database delete ends up blocked, no trace
  // that a duress password existed (or was typed) survives this line.
  try {
    localStorage.clear();
  } catch {
    /* blocked storage cannot hold anything either */
  }
  try {
    sessionStorage.clear();
  } catch {
    /* same */
  }

  // Our own open connection would block deleteDatabase forever - boot
  // already opened it to read the identity record before the unlock screen.
  try {
    const { closeDatabase } = await import("./storage");
    closeDatabase();
  } catch {
    /* module not loaded: nothing holding the handle */
  }

  const jobs: Promise<unknown>[] = [];
  // databases() where available, ALWAYS unioned with the known names - a
  // listing that omits one must not save it.
  const names = new Set<string>(KNOWN_DBS);
  try {
    for (const d of (await indexedDB.databases?.()) ?? []) {
      if (d.name) names.add(d.name);
    }
  } catch {
    /* fall back to the known list */
  }
  for (const name of names) {
    jobs.push(
      new Promise((resolve) => {
        const req = indexedDB.deleteDatabase(name);
        req.onsuccess = req.onerror = () => resolve(null);
        // onblocked (another tab holds a connection) is NOT success: keep
        // waiting - the delete completes the moment the holder closes, and
        // the timeout below stops a wedged wipe from hanging forever.
      })
    );
  }

  try {
    const keys = await caches.keys();
    jobs.push(...keys.map((k) => caches.delete(k)));
  } catch {
    /* no Cache Storage access */
  }

  // Bounded wait: finish properly when unblocked, but never strand the
  // user on a frozen screen if another tab pins a database open.
  await Promise.race([
    Promise.allSettled(jobs),
    new Promise((r) => setTimeout(r, 5000)),
  ]);
  // Replace, not assign: the wiping page must not sit in history.
  location.replace("/");
  return new Promise<never>(() => {});
}
