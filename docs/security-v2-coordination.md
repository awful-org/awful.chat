# Security v2 parallel implementation — resume here

PR workflow update: user subsequently authorized commits/push/PR and dev sync.
See `security-v2-pr-handoff.md` for the current branch, integration and PR status;
the no-commit statements below describe earlier implementation checkpoints.

## Authoritative completion — 2026-09-29

**Local feature completed; shared `ROOM_SECURITY_V2_RELEASED` is true.** No active
agents remain at handoff. Older ownership tables, false-gate statements and open
checklists below are historical checkpoints, superseded by this section. Do not
resume their sessions or repeat their work based on those old labels.

Final real-UI/relay/SFU cross-feature validation passed (main and quick runs),
followed by release-enabled regression cleanup. All six enabled-suite failures
were stale gate-off expectations/legacy fixtures; security rejections were kept.
Explicit release-on tests now cover archive silence and legacy join/scope refusal,
with separately labeled pre-cutover compatibility tests.

Exact shared enabled source: **1722 tests / 165 files passed**, full type checks
**0 errors / 0 warnings**, production/PWA build passed. Fresh relay Go tests and
SFU **21 tests** plus build passed. Final R1–R4 review findings are closed by the
implemented fixes/regressions and applicable browser flows. Detailed evidence,
commands, ownership and resumable checkpoints: `security-v2-release-validation.md`.
Current behavior and protocol limits: `room-security-v2.md`.

Completed gates: private DM first contact/application lifecycle; encrypted file
send/history/download/recovery; invitations/OPAQUE; quick/send/sync/SFU routing;
audit corrections; populated legacy/PWA cutover with local data retention; final
cross-feature browser checks and enabled-source regression/build validation.
Original-author history signatures use fresh authenticated direct channels, not
independently identity-signed history wrappers; this is the documented protocol.

Remaining validation limits are explicit: no physical mobile/device/QR/native
handoff checks, real hardware media-quality assessment, Firefox/WebKit matrix or
cross-network NAT/TURN validation. Ordinary-room and quick calls passed through
the real SFU with synthetic media; **DM-specific call UI was not separately tested**.
Plugin encrypted-image behavior is host API/crypto regression-covered, not a
separate final browser UI case. Nothing committed, pushed or deployed; existing
user changes and staging preserved. Shipping requires coordinated client/relay/SFU.

## Historical coordination log

Retained for provenance only. Current status and ownership are defined above.

## Latest closure — actual app invitations (2026-09-28)

Completed owner `ses_f16f08a90ffeMXhyKw2000GZNf`; evidence and repeatable commands
are in `docs/security-v2-app-invitations-final.md`. Actual production app + Go relay
passed identity creation/unlock, room import/persistence/reload, locked/unlocked
fragment removal, manifest handler URL entry, malformed-input rejection, and
network capability checks (1,899 HTTP/WS observations; zero page errors).
AppView fixes preserve pending invitations across unlock and duplicate navigation
events. Production build and full type checks passed. Native OS handoff is not
claimed. Shared release gate remains false. Remaining cross-feature flows and
final review are still open; this closure supersedes older invitation-navigation
pending entries below.

## Latest dev integration — 2026-09-28

Fast-forwarded dev from ae82b28 to 2cc9dce (four commits). Retained stash
`security-v2 before dev update 2026-09-28` as recovery copy. Reapplied local
work; resolved storage and transport conflicts, combining upstream corrupt-row
healing and ordered file signaling with guarded writes, OPFS discovery and
verified owning-room authorization. Restored original staging convention (only
profile.test.ts staged). No commits or pushes.

Validation on combined tree: 89 storage/WebTorrent/encrypted-transfer/announcement
tests passed, full type checks passed with both frontend/SFU dependency volumes,
and all four real-Chromium attachment recovery/transfer checks passed again.
Bundled PWA check still pending; existing isolated builds predate this pull and
must be refreshed before claiming current-tree validation.

## Backend regression closure after dev update

On merged `dev` ae82b28 plus local security changes, relay `go test ./...`
passed in golang:1.26-bookworm. SFU `npm test && npm run build` passed in
node:22-bookworm with the existing mediasoup-worker volume: 21 tests, zero
failures, TypeScript build successful. This closes post-dev backend regression
checks; browser agent work and release-enabled validation remain outstanding.

## Active final browser-validation owners

Three background agents launched from the post-dev regression-clean tree. Await
completion notifications; do not duplicate or poll their work. Older stopped
agents must not be resumed concurrently with these owners.

| Scope | Session | Durable handoff |
|---|---|---|
| Attachment DB/OPFS recovery and torrent transfer | `ses_f1ae9a9e7ffedmHYE6CnWO5XMk` | `docs/security-v2-attachment-final.md` |
| Actual invitation dialog and join UI | `ses_f1ae5a58fffeTKNPoAgkTJAJRK` | `docs/security-v2-invitation-final.md` |
| Actual bundled-app PWA cutover | `ses_f1ae34c44ffeF9XwDqzYyMFVr4` | `docs/security-v2-pwa-final.md` |

Exclusive writes: attachment owner has transport/file/**, files.svelte.ts,
room-security/file-* and new test-attachment-recovery.mjs; invitation owner has
InvitationDialog.svelte, RoomCreateJoin.svelte, invite-pairing* and new
test-invitation-ui.mjs; PWA owner has sw.ts, room-security/pwa-cutover* and new
test-bundled-cutover.mjs. Each owns only its own handoff above. Package files,
storage/core transport and root release gate remain coordinator-owned. Enabled
builds and old/new bundle builds must use isolated copies under /tmp/opencode,
not alter the shared gate/notices. Use ephemeral test ports.

The second launch initially encountered a WebSocket inbound queue overflow
without a returned session ID. The successful invitation session above is the
only confirmed invitation owner for this wave.

## Real OPFS restart validation — 2026-09-27

`frontend/scripts/test-encrypted-opfs.mjs` passed in Chromium with the actual
production staging, crypto, and durable ciphertext modules (no OPFS mock).
It encrypts 5 MiB + 123 bytes, persists ciphertext, closes the browser process,
reopens the same profile, verifies the unchanged ciphertext content hash and every
decrypted byte. Late-chunk tampering rejects publication and leaves no partial
staging entries. Mid-write cancellation removes the partial durable entry. Wipe
removes persisted recovery data. The isolated profile is removed after testing.

Reproduce using the isolated browser tooling already under `/tmp/opencode`:

```sh
docker run --rm --ipc=host \
  -v /home/flaggzz/repos/awful.chat:/repo \
  -v awful_fe_node_modules:/repo/frontend/node_modules \
  -v /tmp/opencode/security-v2-browser:/harness \
  -e PLAYWRIGHT_MODULE=/harness/node_modules/playwright \
  -e ESBUILD_MODULE=/harness/node_modules/esbuild \
  -w /repo/frontend mcr.microsoft.com/playwright:v1.58.2-noble \
  node scripts/test-encrypted-opfs.mjs
```

This closes browser-storage restart/authentication/cleanup validation only. The
descriptor is held by the test runner across restart, not restored from the app's
encrypted database. Actual torrent re-seeding, peer discovery/transfer, attachment
UI and backup/identity lifecycle integration remain separate open checks. No
production implementation changed in this checkpoint; release remains disabled.

## Post-dev regression closure — 2026-09-27

Updated dev to `ae82b28` and reconciled local security work. Full frontend
check and suite now pass: **1,687 tests / 163 files**, zero type-check errors or
warnings. Log: `/tmp/opencode/security-post-dev-tests.log`. Existing expected
negative-test diagnostics and backup migration warnings remain.

Quick-call session initialization now supplies `inCall` and saves the selected
profile name when preparing either identity. This keeps strict resume validation
while permitting a prepared call to survive refresh. Existing regression covers
host provenance before identity selection and guest resume afterward. Large-file
crypto round-trip uses exact linear byte comparison instead of expensive generic
deep equality (same length and every byte checked), resolving full-suite timeout.

No security release enabled, local changes committed, or pushes made. Remaining
browser/user-flow gates listed below are still outstanding; this closes the
post-dev frontend regression gate only. Pre-update stash remains retained.

## Latest lifecycle fixes — 2026-09-27

Closed deferred-inventory announcement/cache leakage across attachment reset,
guarded attachment insert/status/data commits, and a concurrent status/data sealing
race that changed authenticated metadata after encryption. Receive/send and file
callback operations now thread ownership guards into attachment writes. Five new
regressions; 66 focused tests and full type checks passed. Detailed scope/remaining
browser checks: `security-v2-wave3-lifecycle.md`. Release remains disabled.

## Latest verification — 2026-09-27 invitation relay

Production invitation client and OPAQUE code passed actual Go-relay/two-Chromium
checks for transfer, reuse rejection, wrong-password recovery, cancellation and
attempt exhaustion. No plaintext room secret/password in 62 captured relay
exchanges. Reproducer: `frontend/scripts/test-invitation-relay.mjs`; exact commands
and boundaries in `security-v2-wave3-invitations.md`. This closes the browser
production-client/relay exchange check, not dialog/QR/custom-protocol UI or expiry.
Use pinned pnpm@10.28.0 for frozen installs; current unpinned Corepack selects
pnpm 12 and rejects the existing overrides configuration. Release remains false.

## Current ownership — 2026-09-27

All three wave-3 sessions below reported usage-limit errors. Coordinator has
reclaimed their scopes; do not resume them concurrently. Their stale ACTIVE
labels do not represent running work. Restart also cancelled browser dev servers.

Chromium cutover verification found and fixed an activation/navigation deadlock:
`activate.waitUntil` must not await controlled window navigations, which can wait
for activation themselves. `frontend/scripts/test-security-cutover.mjs` runs the
production helper in actual service workers. It passed offline legacy startup,
failed precache installation/retry, two-tab forced upgrade, localStorage retention,
subsequent update waiting, and fresh-install/no-forced-reload cases. This is a
worker fixture, not complete application or release-enabled UI coverage.

## Previous three-agent wave — 2026-09-25

This section supersedes all older ownership/active-session statements below.
Earlier agents stopped or finished; do not resume them concurrently with these
new owners. User explicitly requested up to three agents. No commits/push/PR.

| Task | Exclusive write scope | Session |
|---|---|---|
| DM/files lifecycle | transport.svelte.ts, dm.svelte.ts, dm-ownership*, files.svelte.ts, transport/file/**, storage.ts and related tests, room-security/file-*, new lifecycle-specific tests | `ses_f27c1b267ffeGii7PD46joNmvQ` |
| Invitation browser integration | invite*, room-code*, room-security/invitation* EXCEPT invitation-release.ts, InvitationDialog/RoomCreateJoin/AppView/ChatView.svelte, App.svelte, palette room/query files, relay/invite* and pairing*, new invitation browser tests | `ses_f27c03c92ffeeYO3h13g4dPLO1` |
| PWA cutover | sw.ts, room-security/pwa* and cutover-specific helpers/tests, ReloadPrompt.svelte, new PWA browser tests/harness | `ses_f27be445affer2F1sqtaYC24OC` |

Agent handoffs: `docs/security-v2-wave3-{lifecycle,invitations,pwa}.md` respectively.
Each records actual checks and outstanding items immediately and at milestones.
Coordinator retains `invitation-release.ts`, manifests/lockfiles, vite config,
shared deployment config, relay/main.go, transport/libp2p core, SFU, and this
manifest. Cross-owner edits must be requested in handoffs, not made directly.
No package installs into shared frontend dependencies by agents. Use isolated
browser harness dependencies under `/tmp/opencode/security-v2-<task>` if needed.
Browser agents must use distinct ports/container names/temp paths; invitation
range 5181/8180/8181, PWA range 5191/8190/8191. Preserve existing local processes.
Do not flip the release gate to simulate passing verification. Report gate-bound
coverage limitations explicitly; coordinator owns release-enabled validation.
Final review and release remain coordinator tasks after these owners finish.
All three launched in background; await automatic completion/error notifications.
Launch state is not proof of continuing execution after a server interruption.

## Latest checkpoint — 2026-09-25 DM review fixes

The DM-review implementation agent `ses_f2a219ab7ffeEWie3WhtpJZPTH` hit its
usage limit after leaving substantive code in dm-ownership.ts, dm.svelte.ts,
transport.svelte.ts and storage.ts. Coordinator took over those files; do not
resume a concurrent writer. Added policy and deferred encrypted-storage regression
tests, verified the integration compiles, and ran the complete frontend suite:
**1,632 tests in 157 files passed**. Full type checks passed with 0 errors/warnings.
Known backup migration diagnostics remain in test output.

Unsigned DM exemption now excludes all live rows, file/plugin rows and text rows
carrying files. Identity guards are threaded through admitted receive/send work
and guarded IDB writes. Deferred encryption tests confirm revoked operations do
not commit messages. See `security-v2-final-dm-review.md` for evidence and the
remaining application-dispatch/browser test gaps. Release gate remains false;
no browser-flow completion, production readiness, commit or push is claimed.

## Current review execution

- Coordinator owns implementation and browser validation setup; prior implementation
  agents stopped on usage limits.
- Bounded read-only DM/history reviewer: `ses_f2a219ab7ffeEWie3WhtpJZPTH`.
  Review completed with DM-1 (unsigned live batches) and DM-2 (async identity
  ownership) findings. Resumed to implement these, with exclusive ownership of
  `transport.svelte.ts`, `dm.svelte.ts`, `storage.ts`, related tests/new DM guard
  helpers, and its review file. Await completion; coordinator does not edit these.
- Browser validation requires a browser local to the shell/container network;
  the built-in browser skill explicitly excludes shell-local localhost servers.

## Latest coordinator checkpoint — sync QR isolation

`generateSyncCode` now invalidates the previous session synchronously, captures
an attempt token, and checks ownership after old cleanup, connection, and QR
generation. Expiry callbacks and error/finally handlers also check ownership.
An old QR promise cannot overwrite a new session's credentials or UI state.
Added a deferred-QR/replacement regression test. Docker validation: 42 sync
tests passed; full `npm run check` passed (zero errors/warnings).
Target password/import cancellation and the irreversible database-write boundary
remain open; this checkpoint does not close the broader sync audit finding.

## User instructions

Complete the remaining implementation, not more isolated primitives. Use
file-disjoint subagents; persist enough state to resume after context/token/server
interruptions. Do not commit, push, or open a PR. Preserve all existing uncommitted
work, especially profile changes and `.claude/`. No old-room migration required.

## Resume procedure

1. Read this file, `docs/room-security-v2.md`, and each agent handoff below.
2. Inspect `git status` before editing. All agents use the same working tree.
3. Resume agents using the session IDs below and the `subagent` tool's `sessionID`.
   If the runtime cannot resume a session, launch a replacement with that handoff
   and the ownership boundaries here; do not assume unfinished work was completed.
4. Do not create duplicate concurrent owners. Do not infer success from passing
   unit tests alone. Persist completed commands/results and actual remaining work.
5. Coordinator integrates cross-owner requests after the relevant owner finishes.

## Ownership (exclusive writes; reads unrestricted)

### DM / core transport agent
- `frontend/src/lib/transport/libp2p/transport.ts` and its security tests
- `frontend/src/lib/transport/transport.svelte.ts`, `dm.svelte.ts`, `dm-codec.ts`
- `frontend/src/lib/transport/call.svelte.ts`, `transmission.svelte.ts`
- `frontend/src/lib/transport/libp2p/voice.ts`
- `frontend/src/lib/room-security/{pairwise,dm-introduction,room-lifecycle,scope,profile-route}*`
- New DM/introduction-specific modules and tests; existing DM application tests
- Handoff: `docs/security-v2-dm-handoff.md`

### Encrypted files agent
- `frontend/src/lib/transport/files.svelte.ts`, `transport/file/**`
- `frontend/src/lib/room-security/file-*`
- `frontend/src/lib/storage.ts`, storage tests, `transport/backup.ts` and backup tests
- `frontend/src/lib/types/message.ts`, message wire/protobuf codecs and codec tests
- Attachment rendering/download components if necessary (not ChatView/AppView)
- Handoff: `docs/security-v2-files-handoff.md`

### Invitations / PAKE / room UI agent
- `frontend/src/lib/room-security/invitation*` (not room-lifecycle)
- `frontend/src/lib/invite*`, `room-code*`, `rooms.svelte.ts`
- `frontend/src/lib/components/{AppView,ChatView,RoomCreateJoin}.svelte`
- `frontend/src/App.svelte`, `frontend/src/lib/palette/{query,commands/rooms}*`
- `frontend/vite.config.ts`, frontend package/lock files (only dependency writer)
- Relay invitation/pairing implementation and corresponding Go tests
- New pairing-specific modules/components
- Handoff: `docs/security-v2-invites-handoff.md`

### Audit agent (read-only implementation)
- Writes only `docs/security-v2-audit-handoff.md`
- Audits remaining plaintext sends, key exposure, bypasses, crypto and deployment
  gaps. Reports precise locations and required changes; does not edit others' code.

### Coordinator
- This file, `docs/room-security-v2.md`, overall integration and final validation
- SFU / mediasoup admission, device sync, quick sessions, plugin routing, PWA update
  enforcement, and remaining files not assigned above
- Do not edit owned files while their agents are active. Request changes through
  the owning agent, or integrate after it finishes.

## Agent sessions

### Live-update and sync checkpoint — 2026-09-24

Coordinator added live plugin admission after signature validation: authenticated
peer DID must match author, signed timestamp is required (60s age / 10s future
tolerance), bounded 8192-entry dedup survives reconnects and fails closed at
capacity. Only PluginEphemeral v3 canonical form adds timestamp; persisted chat
canonical forms remain unchanged. Older unsigned-freshness ephemerals fail
verification intentionally. 40 live-admission/messaging/verify-incoming tests pass.

Source exports now capture transport/token/room before awaiting database reads,
check current ownership before/after sends, and cannot use a replacement session.
Cleanup invalidates global credentials synchronously before disconnect; scanner
stop pins old scanner and clears state before awaiting. cancelSync resets state
before async cleanup. Source/target connect continuations pin their transport;
target import progress/ack/error continuations reject stale transport ownership.
41 sync tests pass, including deferred export and deferred disconnect/replacement
regressions. Final full npm run check passes.

Sync A1 is NOT fully closed: generateSyncCode QR/startup continuations, target
password/import cancellation and irreversible database-write boundary still
need review/tests. Target post-import guards prevent stale network/UI effects
but do not abort database writes already in progress. No resumed agents active.

### Interruption checkpoint — 2026-09-24

DM, files, invitations, sync (`ses_f2e971521ffeaK5LDGnYNoOasl`) and quick sessions
(`ses_f2e786acfffeclnAsrerg5d5Oz`) all reported usage-limit errors. These are
interrupted, not completed. Coordinator temporarily takes ownership of their
files for direct continuation; do not resume any of these agents without
reassigning ownership and telling it about subsequent coordinator edits.

Coordinator additionally integrated fileSignatureBinding in messaging.ts v2/v3
canonical forms, preserving legacy bytes when no encryption descriptor exists.
Malformed descriptors fail verification. All 19 messaging tests pass, including
descriptor removal/key/id/size/chunk/version tampering. Full type check found
two WebTorrent overloaded-method type extraction errors and OPAQUE missing in
Docker dependencies. Replaced store casts with named TorrentOptions store type;
validation pending.

### Coordinator validation checkpoint — 2026-09-24

- Installed locked OPAQUE 1.1.0 in Docker frontend volume with
  `npx --yes pnpm@10.11.0 install --frozen-lockfile --ignore-scripts`.
- Full `npm run check` passed (0 Svelte errors/warnings plus node tsc) after
  WebTorrent cast fixes and installation.
- Plugin host now passes bound room into the core owner's already-added
  `sendCard(pluginId, payload, targetRoom)` API; regression test passes.
- Telemetry scrubs bare/truncated capabilities, colon-form sync bundles and
  custom-protocol invitations. Redact/event suites: 28 passed.
- Encrypted torrent integration tests: 6 passed.
- Security/libp2p/files-announcement run: 73 passed, one large-buffer assertion
  exceeded Vitest's 5-second test timeout. Replaced generic deep equality with
  length/type and exact byte comparison; isolated channel suite: 6 passed.
  Do not describe the original combined run as passing.
- Actual OPAQUE integration tests: 5 passed (transfer, wrong password/attempt cap,
  expiration/cancel, ciphertext tamper, cross-session substitution).
- Preview boundary: 3 passed; messaging: 19 passed (earlier checkpoint).
- Remaining critical work includes sync cancellation, quick flows, plugin
  ephemeral replay, full application DM/file integration review, PAKE relay/UI
  tests, legacy/PWA cutover and real browser/device validation. Release gate stays
  false. No agent is assumed active; all implementation agents reported limits.

### Additional exclusive owner — 2026-09-24

- Sync cancellation fix: `ses_f2e971521ffeaK5LDGnYNoOasl`, launched in background.
- Owns only `frontend/src/lib/transport/sync.svelte.ts`, `sync.test.ts`, and
  `docs/security-v2-sync-handoff.md`; coordinator relinquishes these files while active.
- Audit agent completed its first pass; findings are in its handoff.
- Coordinator fixed the MsgRender remote-preview request boundary via
  `frontend/src/lib/preview-url.ts`. Three focused tests passed in Docker,
  covering invitation, nested encoding, fragments, credentials and malformed URLs.
  Browser/network validation and remaining URL consumers are still pending.

| Task | Session ID | Launch state |
|---|---|---|
| DM / core | `ses_f314e1121ffeU62UuhiyoCofx1` | Resumed in background after usage-limit error; await completion notification |
| Encrypted files | `ses_f314dc51bfferRNpe76EApKorR` | Resumed in background after usage-limit error; await completion notification |
| Invitations / PAKE | `ses_f314d6225ffenu0O8qAdxqdQLn` | Resumed in background after usage-limit error; await completion notification |
| Read-only security audit | `ses_f314d1d3cffeks60HtV3VCwqz8` | Resumed in background after usage-limit error; await completion notification |

These are launch-time states, not proof that a task is still running after a
server interruption. Consult runtime completion notifications and agent handoffs
before resuming. Do not poll or duplicate active work.

### Resume checkpoint — 2026-09-23

All four original launches reported `The usage limit has been reached`, not
completion. After the user's renewed instruction, the coordinator inspected git
status and resumed all four original session IDs with unchanged ownership. Existing
handoffs and uncommitted code remain in place. No agent completion or new test
success is inferred from these relaunches. Do not start replacement owners while
these resumed sessions are active.

## Validation environment

Node dependencies are Docker volumes. Typical command:

```sh
docker run --rm -v /home/flaggzz/repos/awful.chat:/repo \
  -v awful_fe_node_modules:/repo/frontend/node_modules \
  -v awful_sfu_node_modules:/repo/sfu/node_modules \
  -w /repo/frontend node:22-bookworm npx vitest run <target tests>
```

The SFU worker was rebuilt in `awful_sfu_node_modules` for Debian/bookworm.
Coordinator owns production builds (they regenerate tracked third-party notices).
Only invitations agent changes dependency manifests/lockfiles or installs packages.

## Release gates

### Latest coordinator checkpoint — implementation owners stopped

Follow-up validation and review:
- Full frontend suite initially found 11 failures in three stale test fixtures
  (old 65-bit room-code expectation; missing secure-room methods in call/watch
  mocks). Updated fixtures and added protected ordinary-room/DM call-scope tests.
  Subsequent full suite: **156 files, 1625 tests passed**, with expected negative
  test logging and known backup IndexedDB migration warnings. Log:
  `/tmp/opencode/security-v2-vitest.log`.
- Frontend production/PWA build passed before the final connection-generation
  change. Log: `/tmp/opencode/security-v2-build.log`. Generated third-party notices
  include the newly added OPAQUE dependency and remain part of the working diff.
- Relay tests passed again AFTER the v2 protocol constant change.
- Review found pending connection creation/stop could outlive lock/disconnect.
  Added lifecycle generation checks after startup awaits, local-node teardown on
  cancellation, explicit non-autostart node construction, and prevention of an
  old disconnect completion clearing a replacement node. New pending-key lock
  regression plus libp2p suites: **21 tests passed**. Full type check passed after
  fixing `stop(): void | Promise<void>` handling and restoring the Docker OPAQUE
  symlink again. The cause of that recurring dependency symlink removal remains
  unexplained; no source/package drift was intentionally introduced.
- The 1625-test full run predates that final lifecycle patch; its focused tests
  and subsequent type check cover the patch. Final all-path browser/release
  review remains pending; do not represent this checkpoint as rollout completion.

All four sessions listed below reported usage-limit errors. Coordinator has
reclaimed their scopes; no agent is assumed active. Do not resume them concurrently
with coordinator edits without explicitly reassigning ownership.

- [x] Protected quick-flow implementation and adversarial checks: current quick
  suites passed within a 140-test run covering quick, invitations, PAKE adapters,
  DM application security and room-security modules (26 suites).
- [x] SFU legacy acceptance removed in `auth.ts`; server integration helpers now
  use real room capabilities. All 21 SFU tests and `npm run build` passed, including
  explicit legacy-room rejection.
- [x] Relay/client discovery protocol switched together to
  `/awful/rendezvous/2.0.0`; no v1 handler/fallback. Relay `go test ./...` passed
  before the constant change; post-change checks still due.
- [x] Identity lock synchronously notifies room-key owners; protected libp2p
  instances clear their capabilities before awaiting socket teardown. New delayed
  shutdown regression plus real Noise/Yamux/WebSocket tests: 12 passed.
- [x] Latest full frontend type check passed after reinstalling locked OPAQUE in
  the Docker volume. Its package files were present but root symlink was missing;
  the first check failed, frozen-lockfile install repaired it, subsequent check passed.
- [ ] Review pending: pending-connect/lock races and application key ownership,
  full DM/file history/lifecycle integration, pairing UI/browser lifecycle,
  protocol-cutover regression/build/PWA and real browser workflows.
- [ ] Global release gate remains false until those checks complete. These results
  do not constitute completion of the full feature or requested final review.

### Current implementation owners — user requested full implementation then review

All previously running implementation sessions reported usage-limit errors. New
exclusive owners (await completion notifications; do not duplicate their files):
- Invitations/relay/UI: `ses_f2b80f0feffeiD4xTVXYi05Zyi` (original invitation scope).
- Core DM/files: `ses_f2b7f535bffewAQl9Yi5Gfyl8i` (combined original core/file scope,
  excluding backup-restore, sync, messaging).
- Quick flows: `ses_f2b7d4a13ffeuZ57qvTxD9uDuR` (quick modules/components/tests).
- SFU cutover/tests: `ses_f2b584dc5ffeRfMQJ20nEaSD3b` (`sfu/**` only).
- Coordinator owns service-worker cutover, integration review and final checks.

Cross-owner integration still required: switch relay/client rendezvous protocol
to a v2-only identifier at cutover, so installed legacy clients cannot register
with the new relay. Coordinator will apply after main.go/core ownership releases.
The one-time PWA activation boundary is gated by ROOM_SECURITY_V2_RELEASED and
must be enabled only after all application paths and server checks pass.

### Latest resume checkpoint — 2026-09-24, import boundary

- Coordinator completed the pending import cancellation boundary in identity.ts,
  backup-restore.ts and sync.svelte.ts. Cancellation is checked after password/key
  derivation and before identity activation or database mutation. Derived private
  key bytes are wiped when that check rejects. Once writes begin, replacement
  sync sessions wait for the committed import to settle; this is serialization,
  not rollback of a multi-transaction import. Stale password callbacks return null.
- Validation: Docker Node 22 `vitest run src/lib/transport/sync.test.ts
  src/lib/transport/backup-restore.test.ts`: 58 passed (44 sync, 14 backup).
  Backup tests retain existing IndexedDB migration/locked-key warnings.
  `npm run check` passed with zero Svelte errors/warnings and node tsc success.
- Quick-session owner `ses_f2e786acfffeclnAsrerg5d5Oz` resumed in background after
  its confirmed usage-limit error. Owns quick-session modules/components/tests
  and docs/security-v2-quick-handoff.md only; excludes AppView, ChatView, core
  transport, invitation modules, identity, storage and sync. Await its automatic
  completion notification; do not duplicate its work. Other implementation agents
  remain stopped after usage-limit errors unless explicitly resumed later.
- Release gate remains false. Remaining work includes quick-session integration,
  final DM/file lifecycle review, pairing relay/UI validation, client/server/PWA
  cutover and real browser/device checks. All changes remain uncommitted.
- Invitation/PAKE owner `ses_f314d6225ffenu0O8qAdxqdQLn` also resumed in background
  for relay endpoint/boundary tests and UI lifecycle completion, with original
  exclusive invitation ownership and release gate kept false. Quick and invitation
  agents are the only newly resumed implementation owners at this checkpoint.

- [ ] DM private discovery and first contact integrated, not only helper tests
- [ ] Ciphertext seeding/download/reseed and metadata/key handling integrated
- [ ] Invitation lifecycle / PAKE / creation / no legacy downgrade integrated
- [ ] Remaining plugin/quick/session/SFU paths covered
- [ ] Security audit issues resolved or explicitly identified as release blockers
- [ ] Regression checks, frontend/SFU/relay builds and applicable browser checks
- [ ] Status documentation reconciled with actual behavior

The existing core is under construction. No claim of complete protection or
production readiness until these gates are verified.
