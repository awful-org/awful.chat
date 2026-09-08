/**
 * /qc - a call with no account and no room.
 *
 * The opposite trade to /qs. A call is not a file transfer: it is presence
 * heartbeats, a voice roster, an SFU placement, plugin call tiles - all of it
 * already written, all of it reading the app's own stores. Rebuilding that
 * against a bare transport would be a second implementation of the hardest
 * part of this codebase, so /qc runs the REAL stack and makes the two things
 * that must not persist ephemeral instead:
 *
 *   - the identity: a keypair held only in memory (createEphemeralIdentity)
 *   - the database: a throwaway scope, deleted on the way out (quick-storage)
 *
 * What survives on purpose is the name and picture you call under, in
 * localStorage, because being asked who you are before every call is the
 * thing people hate about this kind of page.
 *
 * The libp2p node is ephemeral too (session-key.ts) so a quick call can run
 * beside a tab already signed into the account, without taking its node seat.
 */

import { createEphemeral } from "$lib/identity/identity.svelte";
import { saveAvatar, saveName } from "$lib/profile.svelte";
import { newRoomCode, normalizeRoomCode } from "$lib/room-code";
import {
  joinRoom,
  leaveRoom,
  useEphemeralSession,
} from "$lib/transport/transport.svelte";
import { joinCall, leaveCall } from "$lib/transport/call.svelte";
import { dbName, dropQuickStorage, isQuickStorage } from "./quick-storage";

const PROFILE_KEY = "awful_qc_profile";
/**
 * Everything a stranger sees of you. The picture is a data or https URL, the
 * same string the avatar picker produces - it caps an upload at 512 KB, so
 * this stays well inside a localStorage quota.
 */
export interface QuickProfile {
  name: string;
  avatarUrl?: string;
}

export type QuickCallStage =
  | "preparing"
  | "setup"
  | "joining"
  | "in-call"
  | "failed";

interface QuickCallState {
  stage: QuickCallStage;
  code: string;
  error: string | null;
  /** What the setup screen starts filled in with. */
  profile: QuickProfile;
  /** Whether that profile came back from a previous call. */
  remembered: boolean;
}

/** A name to call under when there is nothing remembered and nothing typed. */
function anonymousName(): string {
  return `Guest ${crypto.getRandomValues(new Uint32Array(1))[0] % 9000 + 1000}`;
}

export function readRememberedProfile(): QuickProfile | null {
  try {
    const raw = localStorage.getItem(PROFILE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<QuickProfile>;
    if (typeof parsed?.name !== "string" || !parsed.name.trim()) return null;
    return {
      name: parsed.name.slice(0, 64),
      avatarUrl:
        typeof parsed.avatarUrl === "string" ? parsed.avatarUrl : undefined,
    };
  } catch {
    return null; // unparseable or blocked: call as a guest
  }
}

/**
 * Keep this profile for the next call, or forget it.
 *
 * A picture that will not fit is dropped rather than losing the name with it:
 * a quota error here would otherwise mean the whole "remember me" silently
 * did nothing.
 */
export function rememberQuickProfile(profile: QuickProfile | null): void {
  try {
    if (!profile) {
      localStorage.removeItem(PROFILE_KEY);
      return;
    }
    try {
      localStorage.setItem(PROFILE_KEY, JSON.stringify(profile));
    } catch {
      localStorage.setItem(PROFILE_KEY, JSON.stringify({ name: profile.name }));
    }
  } catch {
    // Storage blocked entirely: the call still works, it just asks next time.
  }
}

const remembered = readRememberedProfile();

export const quickCall = $state<QuickCallState>({
  stage: "preparing",
  code: "",
  error: null,
  profile: remembered ?? { name: anonymousName() },
  remembered: remembered !== null,
});

/**
 * Mint a code, or take one from a link. The same 65-bit Crockford code rooms
 * use: it IS the membership secret, and a call is no less worth guessing than
 * a room - room-code.ts explains why it is not shorter.
 */
export function setQuickCallCode(fromLink?: string): string {
  quickCall.code = fromLink ? normalizeRoomCode(fromLink) : newRoomCode();
  return quickCall.code;
}

/**
 * Mint the identity and seed the profile, BEFORE the setup screen is usable.
 *
 * The identity has to exist first because every profile row is sealed with
 * its key - the avatar picker writes straight through to storage, and with no
 * session it would fail on the first click. Nothing here touches the network.
 */
/** Set once the ephemeral identity is live. Nothing may join before it is. */
let prepared = false;

export async function prepareQuickCall(): Promise<void> {
  if (quickCall.stage !== "preparing") return;
  if (!isQuickStorage()) {
    // main.ts switches the scope before the app mounts. Without it this page
    // would write a room and a stranger's profile into the user's real
    // database - refuse rather than quietly do that.
    quickCall.stage = "failed";
    quickCall.error = "Quick call storage was not set up - reload the page.";
    return;
  }
  try {
    useEphemeralSession();
    await createEphemeral();
    await saveName(quickCall.profile.name);
    if (quickCall.profile.avatarUrl) {
      await saveAvatar(quickCall.profile.avatarUrl);
    }
    prepared = true;
    quickCall.stage = "setup";
  } catch (err) {
    quickCall.stage = "failed";
    quickCall.error = err instanceof Error ? err.message : String(err);
  }
}

/** Everything between "Join" and being in the call. */
export async function startQuickCall(profile: QuickProfile): Promise<void> {
  if (quickCall.stage !== "setup" && quickCall.stage !== "failed") return;
  // "failed" is a retryable state - but not when what failed was the setup
  // itself. Without this, a page whose storage scope never got switched let
  // the second click join, which is the one outcome that writes a call into
  // the user's real database.
  if (!prepared) {
    quickCall.stage = "failed";
    quickCall.error ??= "Quick call is not set up - reload the page.";
    return;
  }
  quickCall.stage = "joining";
  quickCall.error = null;
  quickCall.profile = profile;

  try {
    // The profile goes in before joinRoom, which broadcasts it to everyone
    // already in the call.
    await saveName(profile.name.trim() || anonymousName());
    if (profile.avatarUrl) await saveAvatar(profile.avatarUrl);
    const joined = await joinRoom(quickCall.code);
    if (!joined) throw new Error("Could not join the call.");
    await joinCall();
    quickCall.stage = "in-call";
  } catch (err) {
    quickCall.stage = "failed";
    quickCall.error = err instanceof Error ? err.message : String(err);
  }
}

/** Hang up and go back to the setup screen, still on the same code. */
export function endQuickCall(): void {
  leaveCall();
  leaveRoom();
  quickCall.stage = "setup";
}

/** The page is going away: hang up and take the database with it. */
export function teardownQuickCall(): void {
  leaveCall();
  void dropQuickStorage();
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  // Dev-only handle, same reasoning as transport.svelte.ts's __awful: a call
  // between two people is only observable with two real browsers.
  (window as unknown as Record<string, unknown>).__qc = {
    state: quickCall,
    dbName,
    startQuickCall,
  };
}

/** The link to hand someone. The code stays in the fragment - see App.svelte. */
export function quickCallLink(code: string): string {
  return `${window.location.origin}/qc#${code}`;
}
