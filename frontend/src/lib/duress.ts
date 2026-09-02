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
 *
 * The record is written whether or not duress is armed (see decoyRecord): a
 * key that only exists once the feature is on makes its own presence the
 * answer, and reading a list of localStorage key names is the cheapest look
 * anyone gets.
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
  /** Opaque: the per-identity keyed hash of ARMED_LABEL when duress is armed,
   *  random bytes of the same shape when it is not. Only an unlocked session
   *  holds the key that tells the two apart, so a storage dump cannot. */
  mark?: string;
  /** Records from before `mark` carried the answer in the clear: false on
   *  the first decoys, absent on real registrations. Read once, migrated. */
  armed?: boolean;
}

const ARMED_LABEL = "awful:duress:armed:v1";

const b64url = (bytes: Uint8Array): string =>
  btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");

/** What an armed record carries: blindValue's HMAC over a fixed label, minus
 *  its prefix so the shape matches randomMark exactly. Throws while locked. */
async function armedMark(): Promise<string> {
  const { blindValue } = await import("./storage-crypto");
  return (await blindValue(ARMED_LABEL)).replace(/^[^:]*:/, "");
}

/** 32 random bytes in the same encoding: indistinguishable from armedMark
 *  to anyone without the identity's index key. */
const randomMark = (): string =>
  b64url(crypto.getRandomValues(new Uint8Array(32)));

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

/**
 * A record with no duress password behind it: a random salt, 32 random bytes
 * where the hash goes, the same iteration count. Nothing anyone can type
 * derives to it.
 *
 * Why write one at all: a key that only EXISTS once duress is armed makes its
 * own presence the answer, and enumerating localStorage key names - a forensic
 * dump, a glance at the Application tab - is the cheapest look there is. Every
 * device carries the key now, holding the same shape of material either way.
 *
 * The answer itself is not in the record either: `mark` is a keyed hash of a
 * fixed label when armed and random bytes otherwise, and the key lives only
 * in an unlocked session. The duress CHECK never needs it (salt and hash are
 * enough, and a decoy's hash matches nothing), so the check still runs
 * locked; only the settings toggle, which runs unlocked, asks which it is.
 */
function decoyRecord(): DuressRecord {
  return {
    salt: b64(crypto.getRandomValues(new Uint8Array(16))),
    hash: b64(crypto.getRandomValues(new Uint8Array(32))),
    iterations: ITERATIONS,
    mark: randomMark(),
  };
}

function writeRecord(rec: DuressRecord): void {
  try {
    localStorage.setItem(DURESS_KEY, JSON.stringify(rec));
  } catch {
    // Blocked storage holds nothing to give away either.
  }
}

/** The stored record, materializing a decoy when there is none or what is
 *  there is unreadable. Never null: every path below wants a salt and a hash
 *  to work against, armed or not. */
function readRecord(): DuressRecord {
  try {
    const raw = localStorage.getItem(DURESS_KEY);
    const rec = raw ? (JSON.parse(raw) as DuressRecord) : null;
    if (rec?.salt && rec.hash && rec.iterations) return rec;
  } catch {
    // Unparseable: replaced below, same as a missing one.
  }
  const decoy = decoyRecord();
  writeRecord(decoy);
  return decoy;
}

// At import, so a device where nobody has ever opened the duress settings
// still carries the key. identity.svelte.ts imports this module at boot.
readRecord();

/** Whether duress is armed. Needs an unlocked session to read the mark;
 *  locked, the answer is "no", which is also what a storage dump gets. */
export async function hasDuressPassword(): Promise<boolean> {
  const rec = readRecord();
  if (rec.mark === undefined) {
    // A record from before the mark: `armed` in the clear, or absent on a
    // real registration. Rewrite it in the opaque shape while a key exists.
    const armed = rec.armed !== false;
    try {
      writeRecord({
        salt: rec.salt,
        hash: rec.hash,
        iterations: rec.iterations,
        mark: armed ? await armedMark() : randomMark(),
      });
    } catch {
      /* locked: leave it for a later unlocked read */
    }
    return armed;
  }
  try {
    return rec.mark === (await armedMark());
  } catch {
    return false;
  }
}

export async function setDuressPassword(password: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await derive(password, salt, ITERATIONS);
  writeRecord({
    salt: b64(salt),
    hash,
    iterations: ITERATIONS,
    mark: await armedMark(),
  });
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
  // Replaced, not removed: an absent key would say "this device never armed
  // duress" as loudly as a present one used to say the opposite.
  writeRecord(decoyRecord());
}

/**
 * True when the entered password is the duress password.
 *
 * Exactly one PBKDF2 runs, over exactly one code path, whether or not a duress
 * password is configured. Returning early on a missing record made an unlock
 * attempt cost one derivation on a device with no duress password and two on a
 * device with one - a difference of hundreds of milliseconds that a coercer
 * holding the device could measure with a stopwatch, learning the feature was
 * armed before the victim typed anything. There is no early return left to
 * make: the decoy record carries a salt and a hash of the same shape, and its
 * hash is 32 random bytes that nothing anyone types can match.
 *
 * Callers run this only AFTER a real unlock has failed (identity.svelte.ts):
 * that is where a duress password can land, and it keeps a successful unlock
 * at one derivation instead of two.
 */
export async function isDuressPassword(password: string): Promise<boolean> {
  const rec = readRecord();
  const hash = await derive(password, unb64(rec.salt), rec.iterations);
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

  // Delivered notifications outlive the page that showed them: they sit in the
  // shade naming the conversations this device is about to claim it never had,
  // and their tap targets survive the wipe. getNotifications only reaches this
  // origin's own.
  try {
    const reg = await navigator.serviceWorker?.getRegistration();
    for (const shown of (await reg?.getNotifications()) ?? []) shown.close();
  } catch {
    /* no service worker, or nothing showing */
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
