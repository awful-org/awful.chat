# Security v2 final source review — 2026-09-28

> **Closure, 2026-09-29:** R1–R4 below were implemented and regression-validated
> in `security-v2-review-fixes.md`; applicable real UI flows subsequently passed
> in `security-v2-cross-feature-final.md`. The final enabled suite/check/build and
> local release decision are in `security-v2-release-validation.md`. The verdict
> below is the original pre-fix review snapshot, not an outstanding blocker list.

## Verdict and scope

**Four finite must-fix findings remain in the inspected rollout integration:**
three P1 ownership/attachment-path defects and one P2 encrypted-image consumer
regression. These are source-established defects, not claimed browser exploits.
Resolve them before the coordinator's final cross-feature browser validation.

Production sources were read-only. This document is the only repository file
written by this review; progress checkpoints were persisted here during review.
No tests, builds, browser sessions, production edits, dependencies, gate changes,
commits, pushes, or further subagents were run/created by this reviewer.
**Cross-feature runtime validation was not performed and remains LAST.**

Inputs: current working-tree diff and security modules;
`security-v2-coordination.md`, original `security-v2-audit-handoff.md`, final DM,
attachment, invitation/actual-app invitation, wave-3 lifecycle, PWA/quick and
populated-PWA handoffs. References below use current source function names;
line numbers are snapshot aids, not stable identifiers.

The populated bundled-PWA result is **accepted as PASSED**, including authentic
old UI-created identity/room/text/file, byte-identical non-telemetry rows,
original-password unlock, exact local attachment download and cold offline
archive readability. Earlier pending entries in that handoff and coordination
are historical, not new release blockers. The findings below do not invalidate
that tested upgrade scenario.

## Must-fix list

### R1 — P1: encrypted batch receipts cannot establish attachment signaling ownership

**Locations**

- `frontend/src/lib/transport/transport.svelte.ts`:
  `_handleSyncBatch` (1990–2030, 2064–2100), `_sendDmBatch`,
  `deliverMailboxBatch`, file-signal dispatch (3577–3614),
  `requestFileDownload` (4776 onward).
- `frontend/src/lib/transport/files.svelte.ts`:
  `stripAndAdoptInlineFiles` (223–237), `fileRoomForPeer` (193–209),
  `routeFileSignal` (180–188).

**Established path:** `_handleSyncBatch` verifies and stores messages, but
creates no attachment rows. Its comment says inline adoption supplies those
rows; that helper skips encrypted/v2/DM files and does nothing when `inline` is
absent. New encrypted sends intentionally contain no inline plaintext.
The separate live `_handleChatMessage` path does create attachment rows, but
the batch handler does not call it. DM file sends use live `SyncBatch`; history
repair and mailbox batch delivery also reach this path.

`fileRoomForPeer` derives eligible rooms exclusively from
`getAttachmentsByInfoHash`. Without a row it returns null. Both outgoing file
signals and incoming seeder/transfer signals now require that ownership.
Registering a sender and calling `ensureDownload` from a rendered file chip
does not supply the missing database row. Repeated batch delivery also does
not heal it: duplicates only retry the same inline-adoption helper.

**Impact:** a fresh receiver can display an authenticated encrypted file
message yet cannot complete normal discovery/signaling/download for that file.
This is an integration availability defect, not proof of plaintext leakage.
Existing attachment-engine/recovery harness passes do not establish that the
application batch path populates these rows.

**Required closure:** create/reconcile owning attachment rows from the verified
stored descriptor in the batch path, with the same identity guard and immutable
descriptor ownership used by live receipt. Include already-held messages whose
rows are missing; do not relax `fileRoomForPeer` to accept arbitrary announcements.
The final application validation must include a fresh DM file receiver and a
new room peer receiving file history, followed by exact-byte download/reopen.

### R2 — P1: identity lock does not invoke application/file/archive teardown

**Locations**

- `frontend/src/lib/identity/identity.svelte.ts`: `lock` (236–240).
- `frontend/src/lib/identity/identity.ts`: `lockIdentity` (496–506).
- `frontend/src/lib/transport/libp2p/transport.ts`: lock observer in `connect`
  (334), `disconnect` (1133–1193).
- `frontend/src/lib/transport/transport.svelte.ts`:
  `disconnectTransport` / `_disconnectWithoutBroadcasting` (4158 onward),
  `beginConversationOpen` (3954), archive `joinRoom` branch (3964 onward).
- `frontend/src/lib/transport/files.svelte.ts`: `initFiles`,
  `hydrateLegacyAttachments` (552–569), `_resetAttachmentHydration` (585).
- `frontend/src/lib/transport/file/webtorrent.ts`: `lifecycle`,
  `restoreEncryptedFile`, `resetTransfers`.

**Established path:** lock clears the identity/storage keys and notifies
observers. The main libp2p observer calls only its own `disconnect`, which
synchronously revokes room security and subsequently stops its node. It does
not call the application's `_disconnectWithoutBroadcasting`.
Repository call-site inspection found `disconnectTransport` only as its
exported definition, and `_disconnectWithoutBroadcasting` only called there.
The application cleanup that revokes its blob URLs, resets the file transport,
clears decrypted messages/plugin/search state and bumps `_fileEpoch` therefore
is not wired to ordinary identity lock.

**Consequences established in source:** already-published plaintext blob URLs
and decrypted view/file state survive lock; WebTorrent's abort controller is
not cancelled by this lock path. New archive hydration checks `_fileEpoch` and
the conversation-open token, neither of which lock invalidates. A hydration
read already in flight can consequently publish a local blob URL after lock.
The download callback's identity checks do not revoke URLs already published
or cancel transport-owned staged plaintext. Hiding AppView's unlocked subtree
does not perform these operations.

This is a concrete missing revocation boundary, **not** a claim that the locked
UI still displays the archive or that libp2p room membership remains authorized.
Existing WebTorrent peers and SFU/media teardown also need checking when wiring
the common cleanup; continued network media was not demonstrated here.

**Required closure:** connect synchronous lock/session invalidation to the
application/file lifecycle: invalidate pending conversation/hydration work,
abort old file work, revoke published URLs and clear decrypted session state.
Keep teardown safe across reconnect and same-DID unlock; old cleanup must not
destroy new-session state. Verification should defer archive hydration and an
encrypted restore/download across lock, and confirm no late URL publication or
old transfer activity. Preserve durable encrypted recovery data on ordinary
lock, as distinct from identity wipe.

### R3 — P1: remaining async sends/imports have no owning-session commit fence

**Locations**

- `frontend/src/lib/transport/transport.svelte.ts`:
  `sendMessage` (4332–4397), `sendFiles` (4418–4544), `sendCard` (4550 onward),
  `sendUpdate` / `sendUpdateImmediately` (4614 onward).
- `frontend/src/lib/room-security/invitations.ts`: `storeSecureInvitation`.
- `frontend/src/lib/components/AppView.svelte`: `handleJoin`.
- `frontend/src/lib/storage.ts`: `guardedCommit` (9–27), `putMessage`
  (1051–1056), `putRoom`, `setWatermark` and their optional `WriteGuard`.

**Established path:** `sendMessage` and `sendCard` await profile/lamport work
without capturing the identity-session object, then sign using the current
session and perform unguarded writes. Plugin update paths likewise omit the
commit guard. `sendFiles` does capture a session and guard its attachment writes,
but its final `putMessage(msg)` / `setWatermark(...)` (4525–4526) omit that
guard and proceed to network/UI effects without rechecking it.

`storeSecureInvitation` awaits a stored-room read and calls unguarded `putRoom`;
AppView's join sequence only detects newer joins and checks after the write.
It is not an identity-session guard. A join/import started under one unlock
can therefore continue under a replacement session.

The new storage transaction lock observer does not close this gap: sealing
happens **before** `guardedCommit` subscribes. When the caller leaves the guard
at its no-op default, a lock during pending sealing can finish and start a new
transaction after the lock event has already passed. Replacement-session
continuations may also obtain/sign/store under the new active session rather
than reject the old operation.

**Impact:** stale outgoing content or imported capabilities can be persisted or
published after their initiating identity session was revoked; exact later
network delivery depends on reconnection/room state. No cross-account browser
disclosure was executed. This is not reopening the corrected guarded DM receive
or `sendDirectMessage` paths from `security-v2-final-dm-review.md`; it is the
remaining ordinary room/file/plugin/invitation integration.

**Required closure:** capture session identity at each operation entry, check
after async boundaries before signing/state/network effects, and pass the
guard through every affected message/room/watermark commit. A post-write check
alone is insufficient. Verify delayed profile/lamport/sealing/invitation reads
across both lock→same-DID unlock and identity replacement, with no stale commit,
signature, echo, or send. R2 teardown alone does not fence resumed promises.

### R4 — P2: plugin image resolver still interprets encrypted attachment storage as plaintext

**Locations**

- `frontend/src/lib/plugins/host.ts`: `makeHostApi().resolveRoomImage`
  (107–147).
- `frontend/src/lib/transport/files.svelte.ts`: `_persistDownloadedBlob`
  (68–96), encrypted hydration/restoration paths.

`resolveRoomImage` returns `new Blob([row.data], { type: row.mimeType })`
immediately when data exists (116). For encrypted attachments that data now
contains **ciphertext**, including a small image that has already downloaded
successfully. The resolver bypasses the authenticated plaintext transfer URL.
When data is absent, its `requestFileDownload` argument (132–137) drops
`row.encryption`, so an OPFS-only/not-yet-downloaded encrypted image is also
requested with an incomplete descriptor. Correct room scoping at row lookup
does not fix either format mismatch.

**Impact:** bundled plugin image consumers receive ciphertext labeled as an
image, or cannot recover the original protected image. This is a new encrypted
storage integration regression, not an allegation that plugins bypass room
authorization or expose room root secrets.

**Required closure:** resolve encrypted rows through authenticated plaintext
restoration/publication, preserve the full protected descriptor when requesting
a download, and retain the existing host-room ownership check. Verify both
DB-backed small images and OPFS-only/restored images through the host API,
checking exact plaintext bytes. Legacy archive rendering itself never invokes
this plugin host.

## Inspected invariants and closed findings

- **Archive boundary:** `legacy-archive.ts`, `joinRoom`, `LegacyArchive.svelte`
  and `hydrateLegacyAttachments` implement an explicit pre-relay storage-only
  path. A saved record is required; capability-bearing legacy records are
  rejected. The archive mounts plain text/local downloads rather than MsgRender,
  plugin/composer/watch effects. Local hydration skips encrypted rows and does
  not seed or mutate stored attachments. Write APIs, seen markers, archive
  reseeding and legacy inventory announcements have cutover checks. AppView
  suppresses the global action palette/plugin confirmation while archived.
  No new legacy network fallback was found. R2 concerns lifetime, not the
  successful old-data preservation/local-only behavior.
- **Live/history signatures:** `_verifyIncoming` applies protected-file
  descriptor admission before verification. `allowsUnsignedDmHistory` is
  non-live only, authorized-author only, Text/Reply/Reaction only, with no file
  descriptors. File/plugin batch rows do not inherit that compatibility
  exemption. Stored IDs are not overwritten by replayed history; received
  batch writes use the captured guard. `LiveUpdateAdmission` binds ephemeral
  signer to authenticated peer, checks freshness and bounds replay IDs.
  Direct secure channel envelopes bind peer/room/membership transcript/session/
  sequence. History deliberately verifies original-author signatures within
  a fresh authenticated channel, not a newly identity-signed wrapper. This is
  not a new forged-history finding.
- **Invitation exposure:** AppView consumes/removes incoming capabilities from
  the URL while locked or unlocked; sharing reads the sealed saved capability
  rather than treating `rd2_` as an invitation. `remotePreviewUrl` blocks
  capability/custom-protocol/fragment/pairing/sync inputs, checks encoded
  wrappers with a bound and rejects excessive/invalid encodings before the
  preview query is built. Diagnostic scrubbing covers bare `r2_` strings as
  well as URLs. Actual-app invitation handoff records 1,899 observed HTTP/WS
  events and no capability leak; those runtime results were not rerun here.
  No current automatic root-secret logging source was established. R3 is
  ownership of asynchronous import, not renewed OG-preview leakage.
- **Encrypted descriptor and bytes:** `fileSignatureBinding` includes key, ID,
  size/chunk size/version and dimensions for encrypted files while retaining
  legacy canonical bytes. Protected scopes reject absent/invalid encryption
  descriptors. Seed announcements resolve to the stored signed descriptor,
  not a seeder-selected key. File staging uses fresh keys, chunk authentication,
  bounded slices and no partial plaintext publication; durable OPFS uses opaque
  hash paths. Restore reuses original ciphertext and checks the resulting
  torrent hash. Existing engine/browser recovery passes remain evidence for
  those paths; R1 and R4 are uncovered application consumers.
- **SFU/relay cutover:** SFU admission rejects non-`rs2_` room identifiers and
  verifies a canonical room-capability signature in addition to the peer
  signature before join state. Room-bound producer/consumer routing was not
  found to offer a legacy bypass. Relay registers the v2 rendezvous protocol
  without a v1 fallback; old invitation endpoints return Gone. Deployment must
  still use the coordinated versions. No new cross-room media exploit is
  claimed from this source review.
- **PWA lifecycle:** precache install completes before forced cutover activation;
  marker state is outside per-build precache, completion is persisted before
  navigation, and navigation does not extend activation's lifetime. Subsequent
  updates retain normal waiting/acceptance. No archive-row migration is part
  of this marker path. The populated run's roughly 300-second two-tab cutover
  is recorded latency, not a failed gate or a new data-loss finding.
- **Previously corrected audit paths:** bound-room plugin `sendCard`, guarded
  sync lifecycle/import boundaries, protected quick-session transport and
  encrypted quick-send have implementation/handoff evidence; they are not
  repeated as their old “still unimplemented” findings here.

## Limitations and coordinator handoff

This was a bounded review of the rollout diff, not a new audit of unrelated
features or a certification of all runtime combinations. No runtime exploit,
native OS protocol handoff, real multi-device media interaction, or lock-race
reproduction was performed. Members can share capabilities; key rotation,
forward secrecy and media E2EE retain their documented scope limitations.

The existing successful attachment, invitation, backend, quick/sync and PWA
checks should be retained at their stated scope, rather than reset by stale
checklists. They do not prove the specific missing application paths above.

**Next sequence:** coordinator resolves R1–R4 and runs focused regression checks
for those changes; then performs the final cross-feature browser validation
LAST, including batch-delivered attachments, lock/unlock ownership, encrypted
plugin image use and continued offline archive readability. Keep the shared
release gate unchanged until the coordinator completes that decision.
