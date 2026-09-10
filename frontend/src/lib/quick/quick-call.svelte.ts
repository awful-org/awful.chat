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
 * Who you are in the call is a choice: a throwaway identity under a name this
 * page remembers in localStorage (being asked who you are before every call
 * is the thing people hate about this kind of page), or the account this
 * device already has - same DID, same profile, still a disposable database.
 *
 * The libp2p node is ephemeral too (session-key.ts) so a quick call can run
 * beside a tab already signed into the account, without taking its node seat.
 */

import { createEphemeral, identityStore } from "$lib/identity/identity.svelte";
import { generateMnemonic } from "$lib/identity/identity";
import { loadProfile, saveAvatar, saveName } from "$lib/profile.svelte";
import {
  clearAtRestFlagForCurrentOwner,
  closeDatabase,
  getOwnProfile,
  putOwnProfile,
} from "$lib/storage";
import { newQuickCode, normalizeQuickCode } from "$lib/room-code";
import {
  joinRoom,
  leaveRoom,
  useEphemeralSession,
} from "$lib/transport/transport.svelte";
import { joinCall, leaveCall } from "$lib/transport/call.svelte";
import { dbName, dropQuickStorage, useQuickStorage } from "./quick-storage";

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
  /** Deciding who to be: only reached when this device HAS an account. */
  | "choosing"
  /** The account's own unlock screen is up. */
  | "unlocking"
  /** Name and picture, then Join. */
  | "setup"
  | "joining"
  | "in-call"
  /** Hung up. The call, the chat and the database it lived in are gone. */
  | "ended"
  | "failed";

interface QuickCallState {
  stage: QuickCallStage;
  /** Which identity is in the call: a throwaway one, or the real account. */
  identity: "guest" | "account";
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

/**
 * What a page reload has to come back as.
 *
 * sessionStorage, not localStorage: it survives a refresh and dies with the
 * tab, which is exactly the lifetime this page promises. Without it a refresh
 * mid-call was a silent eviction - a new identity, a new database, back on the
 * setup card being told you had been "invited" to the call you started, while
 * the other side kept a ghost of you in its roster until the TTL swept it.
 *
 * Coming back under the SAME key is what avoids that ghost: the roster entry
 * is reused rather than duplicated, and the room's history is pulled back off
 * the other peers by the ordinary digest, so nothing has to be persisted for
 * it. A guest's mnemonic goes in here to make that possible; an account's key
 * never does, and a reload asks it to unlock again.
 */
const SESSION_KEY = "awful_qc_session";

interface QuickSession {
  code: string;
  isHost: boolean;
  identity: "guest" | "account";
  /** Guest only. Re-derives the same DID, so peers see a reconnect. */
  mnemonic?: string;
  name: string;
  avatarUrl?: string;
  /** Whether to walk straight back into the call rather than the setup card. */
  inCall: boolean;
}

let session: QuickSession | null = null;

function readSession(): QuickSession | null {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as QuickSession;
    return typeof p?.code === "string" && p.code ? p : null;
  } catch {
    return null;
  }
}

function saveSession(patch: Partial<QuickSession>): void {
  session = { ...(session ?? ({} as QuickSession)), ...patch };
  try {
    sessionStorage.setItem(SESSION_KEY, JSON.stringify(session));
  } catch {
    // Blocked: a refresh then behaves as it did before, which is survivable.
  }
}

function clearSession(): void {
  session = null;
  try {
    sessionStorage.removeItem(SESSION_KEY);
  } catch {
    /* nothing to clear */
  }
}

/**
 * Whether this page load is a refresh of a call already in progress, for the
 * code on screen. The caller uses it to skip the screens the person has
 * already been through.
 */
export function resumableSession(code: string): QuickSession | null {
  const found = readSession();
  return found && found.code === code ? found : null;
}

const remembered = readRememberedProfile();

export const quickCall = $state<QuickCallState>({
  stage: "choosing",
  identity: "guest",
  code: "",
  error: null,
  profile: remembered ?? { name: anonymousName() },
  remembered: remembered !== null,
});

/**
 * Mint a code, or take one from a link. A quick code, not a room code: ten
 * characters for a call that lives hours, see room-code.ts for the numbers.
 * A link carrying something else falls back to a fresh code rather than
 * joining whatever the string happened to name.
 */
export function setQuickCallCode(fromLink?: string, isHost?: boolean): string {
  quickCall.code =
    (fromLink ? normalizeQuickCode(fromLink) : "") || newQuickCode();
  // Host-ness cannot be re-derived after a reload: the person who STARTED the
  // call has the code in their address bar by then, and would be told they
  // had been invited to it.
  saveSession({ code: quickCall.code, isHost: isHost ?? !fromLink });
  return quickCall.code;
}

/**
 * Switch this page onto its throwaway database.
 *
 * Everything before this ran against the REAL one, because that is where the
 * account's keypair and profile live and "use my account" has to be able to
 * read them. The handle is closed first: the module caches an open
 * connection, and leaving it open would keep writing to the wrong database.
 *
 * From here on the page is disposable. The libp2p node goes ephemeral in the
 * same breath - whichever identity is in the call, the node must not take the
 * seat belonging to a tab running the account (node-lock.ts).
 */
function switchToThrowawayStorage(): void {
  closeDatabase();
  useQuickStorage();
  useEphemeralSession();
}

/** Set once an identity is live and the storage scope has moved. */
let prepared = false;

/**
 * Call as a stranger: a keypair that exists only in memory, under whatever
 * name was remembered from last time.
 */
export async function prepareAsGuest(mnemonic?: string): Promise<void> {
  if (prepared) return;
  quickCall.identity = "guest";
  quickCall.error = null;
  try {
    switchToThrowawayStorage();
    // Minted here rather than inside createEphemeral so the same words can be
    // put away for a reload. A resume passes back what it kept.
    const words = mnemonic ?? generateMnemonic();
    await createEphemeral(words);
    saveSession({ identity: "guest", mnemonic: words });
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

/** Show the account's own unlock screen. */
export function chooseAccount(): void {
  quickCall.identity = "account";
  quickCall.error = null;
  quickCall.stage = "unlocking";
}

/**
 * Carry the unlocked account into the call: same DID, same profile, same
 * name colour and tag the room would show - but still a disposable database
 * and a disposable node, so the call itself is no more permanent than a
 * guest's. Called once identityStore reports the unlock landed.
 *
 * The whole profile ROW is copied rather than the display store: an uploaded
 * avatar lives in the store as a blob: URL, which means nothing to anyone
 * else, and copying the row keeps the bytes (and the colour, tag and bio)
 * that _sendProfile actually puts on the wire.
 */
export async function adoptAccount(): Promise<void> {
  if (prepared) return;
  quickCall.error = null;
  try {
    const mine = await getOwnProfile(identityStore.did ?? undefined);
    switchToThrowawayStorage();
    saveSession({ identity: "account" });
    if (mine) await putOwnProfile({ ...mine, isMe: true });
    await loadProfile();
    quickCall.profile = {
      name: mine?.nickname?.trim() || quickCall.profile.name,
      avatarUrl: mine?.pfpURL ?? quickCall.profile.avatarUrl,
    };
    prepared = true;
    quickCall.stage = "setup";
  } catch (err) {
    quickCall.stage = "failed";
    quickCall.error = err instanceof Error ? err.message : String(err);
  }
}

/** Everything between "Join" and being in the call. */
export async function startQuickCall(profile: QuickProfile): Promise<void> {
  // Checked FIRST, and loudly. "failed" is a retryable state - but not when
  // what failed was the setup itself, and a join before any identity exists
  // is the one path that would write a call into the user's real database.
  if (!prepared) {
    quickCall.stage = "failed";
    quickCall.error ??= "Quick call is not set up - reload the page.";
    return;
  }
  if (quickCall.stage !== "setup" && quickCall.stage !== "failed") return;
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
    saveSession({
      inCall: true,
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    });
  } catch (err) {
    quickCall.stage = "failed";
    quickCall.error = err instanceof Error ? err.message : String(err);
  }
}

/**
 * Hang up, and take the call with you.
 *
 * leaveRoom already does the wire half - it broadcasts the leave so the others
 * see you go, unsubscribes the topic, hangs up, and empties the messages on
 * screen. What it does not do is get rid of what the call wrote, and for a
 * quick call that is the whole promise: there is no history here, and anybody
 * who wants some makes a room instead.
 *
 * So the database goes too. The cached connection is closed first or the
 * delete queues behind it and the rows outlive the call; dropQuickStorage
 * then rotates to a fresh empty scope, so the participant removal still in
 * flight from leaveRoom lands somewhere disposable rather than in the user's
 * real database.
 */
export function endQuickCall(): void {
  leaveCall();
  leaveRoom();
  // Nothing resumes a call that was deliberately ended.
  clearSession();
  closeDatabase();
  void dropQuickStorage();
  quickCall.stage = "ended";
}

/**
 * Start over on a new code, in the empty scope the hang-up left behind. The
 * identity is the same one - it lives in memory and dies with the tab either
 * way - so this is a new call, not a new person.
 */
export function startAnotherCall(): string {
  quickCall.error = null;
  const code = setQuickCallCode(undefined, true);
  quickCall.stage = "setup";
  return code;
}

/** Leave for good: nothing here is resumed by a later page load. */
export function forgetQuickCallSession(): void {
  clearSession();
}

/** Whether this device has an account that could be brought into the call. */
export function hasAccount(): boolean {
  return identityStore.keypair !== null;
}

/** The page is going away: hang up and take the database with it. */
export function teardownQuickCall(): void {
  leaveCall();
  // An ephemeral identity's "database swept" marker is localStorage that
  // would outlive everything else about the call. The account path leaves the
  // real account's own marker alone - it earned it on the real database.
  if (quickCall.identity === "guest") clearAtRestFlagForCurrentOwner();
  void dropQuickStorage();
}

/** Test seam: the module keeps one page's worth of state. */
export function _resetQuickCallForTest(): void {
  prepared = false;
  quickCall.stage = "choosing";
  quickCall.identity = "guest";
  quickCall.error = null;
}

if (import.meta.env.DEV && typeof window !== "undefined") {
  // Dev-only handle, same reasoning as transport.svelte.ts's __awful: a call
  // between two people is only observable with two real browsers.
  (window as unknown as Record<string, unknown>).__qc = {
    state: quickCall,
    dbName,
    startQuickCall,
    did: () => identityStore.did,
  };
}

/** The link to hand someone. The code stays in the fragment - see App.svelte. */
export function quickCallLink(code: string): string {
  return `${window.location.origin}/qc#${code}`;
}
