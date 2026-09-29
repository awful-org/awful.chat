# Final DM application review

Status: bounded source review followed by implementation and regression checks
(2026-09-25). Original findings below are retained as review evidence. Coordinator
reclaimed implementation ownership after the implementing agent hit its usage limit.

## Fix validation — 2026-09-25

- DM-1: `_handleSyncBatch` now calls `allowsUnsignedDmHistory`, restricting the
  exemption to non-live Text/Reply/Reaction repair rows with an authorized author
  and no file descriptors. File/plugin rows cannot acquire the exemption by
  pretending to be historical or coming from an own-device peer. Policy matrix
  regressions cover these distinctions.
- DM-2: implementation now captures identity-session objects and checks ownership
  across receive/send awaits. Message/history/room/watermark writes take guards;
  their IDB transactions observe identity lock and abort pending work. Offline
  mailbox import is followed by an ownership check before signing/local echo.
- Added a real encrypted-storage regression delaying AES encryption, revoking
  ownership, then completing encryption: no message is committed. Also covered
  revoked batch/room/watermark writes and same-DID session replacement.
- 67 focused tests passed (storage, ownership policy, DM security, verifier).
- Full frontend suite: **1,632 tests / 157 files passed**; full Svelte/TypeScript
  checks: **0 errors / 0 warnings**. Storage tests emit expected corruption
  diagnostics; full suite retains known backup migration lifecycle warnings.
- Not claimed closed by these tests: full application receive-dispatch races,
  attachment adoption/notification side effects, real browser identity replacement,
  or the overall end-to-end DM release gate. The guards and storage boundary are
  tested; the remaining application/browser coverage still needs completion.

Checkpoint read: current coordination file includes the later import-boundary
checkpoint and full-suite/lifecycle validation records. Those records are not
evidence that all DM browser paths were validated.

Initial source evidence:
- `dm.svelte.ts:672-679`: live sends use `sendRoom` after pairwise-room setup;
  failure returns false, with no raw-send fallback.
- `dm.svelte.ts:808-842`: room setup captures the identity session and checks it
  before joining the secure conversation and after introduction/storage awaits.
- Pending review: unsigned history exemption, authenticated origin/local alias
  enforcement, capability absence, and async identity ownership in receive paths.

## Defects requiring coordinator action

### DM-1 — unsigned exemption also admits live SyncBatch traffic (medium)

`transport.svelte.ts:1703-1721,1734-1737` selects the unsigned allowance solely
from the authenticated DM sender; `live` is never tested. Dispatch at
`3620-3627` and mailbox delivery at `3179-3184` pass the sender-controlled live
flag. Consequently an unsigned counterparty-authored File, PluginCard or
PluginUpdate in a live batch passes `verifyIncoming` at
`verify-incoming.ts:76-79`. This contradicts `VerifyOpts`' explicit history-only,
never-live contract (`35-37`) and the mailbox batch's v3-per-row contract
(`transport.svelte.ts:3156-3160`). Bare live chat requires signatures at
`3650`, so wrapping it changes admission policy.

This is not demonstrated cross-identity impersonation: the counterparty
allowance is restricted to its own senderId; the own-device wildcard requires
our DID. It is a signature-policy bypass for live batch types, including file
metadata expected to be authenticated by message signatures.

Action: make the exemption explicitly history-only and constrain it to the
intended mirrored DM row types, or document and test an intentionally broader
channel-authenticated contract. Add application receive tests for live versus
repair, own-device versus counterparty, and mailbox batches. A malicious sender
can label a live delivery as repair, so the live flag alone cannot establish
that an unsigned row truly is historical; type restrictions matter if File and
plugin rows must always carry signatures.

### DM-2 — admitted application receives outlive identity ownership (high)

The transport revokes capabilities on lock, but already-dispatched work lacks
an application-session fence:

- `_handleSyncBatch` checks joined rooms only at `1673`, then awaits room-code
  hashing (`1711`), verification (`1734`), database inspection (`1909`) and
  blinding (`1912-1922`) without capturing/checking `requireSession()`. It then
  adopts attachment data (`1962-1972`) and continues persistence/UI work.
- `_handleDmChatAsync` awaits guarded `ensureDmRoomForPeer` (`3241`), but
  subsequent `getMessage` (`3296`), `putMessage` (`3297`), watermark and room
  refresh (`3301-3302`) have no ownership checks. A lock/replacement while the
  read is pending leaves an old message continuation able to write or announce
  (`3310`) under the new active application context.
- Send-side counterpart: `sendDirectMessage` checks its session at `540`, then
  awaits mailbox dynamic import at `561` and reads current identity/signs/echoes
  at `573-613` before the next check at `619`. With the offline mailbox branch
  delayed across identity replacement, the old operation can acquire the new
  sender identity and echo before rejection. The receipt helper already has the
  desired post-import check (`659-664`).

Action: capture ownership at receive/send entry, check after async boundaries
before side effects, and give persistence a guarded commit boundary (a late
check after a write is insufficient). Add deferred `getMessage`, verification/
history lookup, and mailbox-import regressions that switch identity or lock;
assert no old-operation writes, notifications, echoes, attachment adoption or
receipts. Transport shutdown tests alone cannot close this finding. These are
source-established missing guards; browser race reproduction was not run.

## Closures supported by current source

- **DM origin and room binding:** secure transport emission uses the Noise
  connection's `remotePeer` and locally mapped authenticated room
  (`libp2p/transport.ts:353-362`), not payload origin. Stream setup binds the
  channel to `connection.remotePeer` (`room-security/stream.ts:63`). DM envelopes
  require room membership (`transport.svelte.ts:3419`) and a DID-derived matching
  conversation plus membership recheck (`3222-3224`). History restricts the
  counterparty to the expected DID-derived room (`1704-1717`). Scope validation
  precedes decoded dispatch (`3464-3465`); `scope.ts:12-13` rejects contradictory
  payload room claims for both protected public IDs and local DM IDs.
- **Unsigned history author restriction:** counterparty rows must name that
  counterparty (`1719-1721`); claiming our senderId is not exempt. Own paired
  devices get the deliberate wildcard (`1707-1709`). Signed rows still require
  v3, signing DID equal to senderId, and signature verification using the
  authenticated room (`verify-incoming.ts:96-120`). This closes the old blanket
  counterparty-can-forge-our-unsigned-history claim, subject to DM-1/DM-2.
- **Local aliases and missing capabilities:** aliases map to private discovery
  IDs and reverse-map for application events (`libp2p/transport.ts:285-322`).
  Conflicting aliases are rejected and mappings retained after leave. `sendRoom`
  rejects unbound `dm-`, root secrets and missing secure channels rather than
  raw-send fallback (`378-385`); `dm.svelte.ts:673-679` has no fallback either.

## Existing coverage versus unverified integration

Reviewed existing test source (not rerun):
- `dm-security.test.ts:51-75`: phonebook capability derivation, protected text/
  batch sends, and lock during room lookup. Transport module is mocked, so this
  does not exercise receive dispatch, history admission or browser storage races.
- `libp2p/transport-room-security.test.ts:53-110`: missing-capability fail-closed,
  alias discovery privacy, leave/disconnect stale sends, conflicts, and roster
  claims not authorizing peers. Earlier tests in that file cover pending connect
  and synchronous lock revocation.
- `verify-incoming.test.ts:241-253`: default unsigned rejection and explicit
  allowance. This tests the verifier, not whether the application supplies the
  allowance only in the right circumstances.
- `scope.test.ts:4-18`: v2 mismatch/plaintext downgrade rejection and matching
  context; these assertions use rd2 IDs, not an end-to-end DM receive.

Coordinator checkpoint records prior full-suite and focused lifecycle passes;
this review makes no new execution claim. Real two-device first contact,
phonebook reconnect, mailbox delivery, own-device history restore, and identity
replacement during history/live persistence remain unverified browser paths.

Recommendation: fix DM-2 before release; resolve and explicitly test DM-1's
admission contract. Do not mark application DM lifecycle review closed based
only on the existing transport and pure-verifier tests.
