/**
 * identity.svelte.ts
 *
 * Reactive Svelte 5 store for the current identity session.
 * Wraps the lock/unlock lifecycle from identity.ts and exposes
 * $state-based values that components can read reactively.
 *
 * Usage in a component:
 *
 *   import { identityStore } from "$lib/identity.svelte";
 *
 *   // Reactive — re-renders when the session locks/unlocks
 *   {#if identityStore.isUnlocked}
 *     <p>Signed in as {identityStore.did}</p>
 *   {/if}
 */

import type { KeypairRecord, WebAuthnCapabilities } from "./identity";
import {
  createIdentity,
  getIdentity,
  lockIdentity,
  restoreIdentity,
  unlockIdentity,
  enrollWebAuthn,
  hasWebAuthnEnrollment,
  unlockWithWebAuthn,
  getWebAuthnCapabilities,
} from "./identity";
import { deleteWebAuthnRecord } from "./storage";

interface IdentityStore {
  /** True when the private key is held in memory and signing is available. */
  isUnlocked: boolean;
  /** The active did:key, or null when locked. */
  did: string | null;
  /** The active ed25519 public key bytes, or null when locked. */
  publicKey: Uint8Array | null;
  /** The persisted keypair record (populated by init()), or null if no identity exists. */
  keypair: KeypairRecord | null;
  /** True while an async operation (unlock/create/restore) is in progress. */
  loading: boolean;
  /** Last error message from an unlock/create/restore attempt. Cleared on the next call. */
  error: string | null;
  hasWebAuthn: boolean;

  webAuthnCapabilities: WebAuthnCapabilities | null;
}

export const identityStore = $state<IdentityStore>({
  isUnlocked: false,
  did: null,
  publicKey: null,
  keypair: null,
  loading: false,
  error: null,
  hasWebAuthn: false,
  webAuthnCapabilities: null,
});

function setUnlocked(keypair: KeypairRecord): void {
  identityStore.isUnlocked = true;
  identityStore.did = keypair.did;
  identityStore.publicKey = keypair.publicKey;
  identityStore.keypair = keypair;
  identityStore.error = null;
}

function setLocked(): void {
  identityStore.isUnlocked = false;
  identityStore.did = null;
  identityStore.publicKey = null;
}

/**
 * Load the persisted keypair record from IndexedDB (public data only).
 * Call this once on app startup to know whether an identity exists.
 * Does not unlock the session — use unlock() for that.
 */
export async function init(): Promise<void> {
  identityStore.loading = true;
  identityStore.error = null;
  try {
    identityStore.keypair = await getIdentity();
    identityStore.hasWebAuthn = await hasWebAuthnEnrollment();
    identityStore.webAuthnCapabilities = await getWebAuthnCapabilities();
  } finally {
    identityStore.loading = false;
  }
}

/**
 * Generate a new identity and immediately unlock the session.
 * Updates the store reactively on success.
 *
 * @returns The plaintext mnemonic — show it to the user once for backup.
 * @throws Re-throws any underlying error after setting store.error.
 */
export async function create(password: string): Promise<string> {
  identityStore.loading = true;
  identityStore.error = null;
  try {
    const { keypair, mnemonic } = await createIdentity(password);
    setUnlocked(keypair);
    return mnemonic;
  } catch (err) {
    identityStore.error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    identityStore.loading = false;
  }
}

/**
 * Restore an identity from an existing mnemonic and immediately unlock the session.
 * Updates the store reactively on success.
 *
 * @throws Re-throws any underlying error after setting store.error.
 */
export async function restore(
  mnemonic: string,
  password: string
): Promise<void> {
  identityStore.loading = true;
  identityStore.error = null;
  try {
    const keypair = await restoreIdentity(mnemonic, password);
    setUnlocked(keypair);
  } catch (err) {
    identityStore.error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    identityStore.loading = false;
  }
}

/**
 * Decrypt the stored mnemonic and load the private key into memory.
 * Updates the store reactively on success.
 *
 * @throws Re-throws any underlying error (wrong password, no identity) after setting store.error.
 */
export async function unlock(password: string): Promise<void> {
  identityStore.loading = true;
  identityStore.error = null;
  try {
    await unlockIdentity(password);
    // Re-read the keypair record for public key and did
    const keypair = await getIdentity();
    if (!keypair) throw new Error("Identity record missing after unlock.");
    setUnlocked(keypair);
  } catch (err) {
    identityStore.error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    identityStore.loading = false;
  }
}

/**
 * Zero out the private key in memory and update the store.
 * Call this on logout or when the app goes to the background.
 */
export function lock(): void {
  lockIdentity();
  setLocked();
}

/**
 * Enroll a WebAuthn credential. Call after a successful password unlock.
 * @throws If PRF not supported, or user cancels the authenticator prompt.
 */
export async function enroll(password: string): Promise<void> {
  identityStore.loading = true;
  identityStore.error = null;
  try {
    await enrollWebAuthn(password);
    identityStore.hasWebAuthn = true;
  } catch (err) {
    identityStore.error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    identityStore.loading = false;
  }
}

/**
 * Unlock via WebAuthn biometrics/PIN. Falls back gracefully if unsupported.
 * @throws If no enrollment, authenticator cancelled, or PRF unavailable.
 */
export async function unlockWithBiometrics(): Promise<void> {
  identityStore.loading = true;
  identityStore.error = null;
  try {
    await unlockWithWebAuthn();
    const keypair = await getIdentity();
    if (!keypair) throw new Error("Identity record missing after unlock.");
    setUnlocked(keypair);
  } catch (err) {
    identityStore.error = err instanceof Error ? err.message : String(err);
    throw err;
  } finally {
    identityStore.loading = false;
  }
}

export async function removeWebAuthn(): Promise<void> {
  await deleteWebAuthnRecord();
  identityStore.hasWebAuthn = false;
}
