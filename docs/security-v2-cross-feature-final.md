# Final cross-feature browser validation

Owner: `ses_f12f60e81ffeaRgPcuHvPVI1Xu`, 2026-09-29. Completed available automated checks.
Owns `frontend/scripts/test-cross-feature.mjs` and this handoff. No further
agents, commits, pushes or deployment. Shared release gate remains false.

Initial checkpoint: read review-fixes (1,719 tests/165 files and check passed),
actual-app invitations, final review, attachment handoffs and dirty git status.
Important environment change: `/tmp/opencode` is empty in this resumed runtime;
prior isolated builds, dependencies, certificates and evidence are not present.
Next: inspect available runtime tooling, recover actual bundled-app harness,
execute room/DM/file flows with real relay and app-driven signaling; record
actual results and blockers here. Prior bridged attachment tests do not count.

## Environment restored

- Isolated current source `/tmp/opencode/cross-feature/current`; only its
  `invitation-release.ts` enabled. Fresh isolated dependencies installed with
  `CI=true npx pnpm@10.11.0 install --frozen-lockfile`. Build and full check passed
  (exit 0), log `/tmp/opencode/cross-feature/build-check.log`.
- Existing dependency volume lacked OPAQUE; latest corepack pnpm 12 rejected
  lockfile configuration. pnpm 10 with fresh isolated dependencies resolved both.
- Port 8080 became occupied by `awful-dev-relay`; preserved it. Own real Go relay
  `security-v2-cross-relay-isolated` maps 18080/18081; PeerID
  `12D3KooWKxKbUJjJHZXHxVbQSzDb9f3UYDG9VCXasJ1gWx5jceXH`.
- New UI-only harness launches independent Chromium processes, real runtime
  config and TLS relay passthrough; no imported app modules or signaling bridge.
  First execution running; log `/tmp/opencode/cross-feature/run-1.log`.

## First runtime milestone

Correction: initial enabling substitution missed the typed boolean declaration;
run-1 correctly displayed the closed release gate. Fixed **isolated copy only**,
rebuilt and full typechecked successfully (`enabled-build-check.log`, exit 0).
No shared production files changed.

`run-3.log` establishes actual independent Chromium processes, UI-created
identities, room create/join, bidirectional room text, persisted history after
reload/unlock, reconnect live text, and exact-byte 128 KiB + 123 attachment
download through normal Download file → Download UI. No signaling bridge.
Run then stopped at a harness navigation omission: Bob remained in the room
while the incoming DM badge was already visible. Added DMs-tab navigation.
Run-2's filename click was likewise a harness error, not a file-transfer defect.

Expanded run-4 now checks fresh third-peer room history/file download/reopen,
first-contact DM delivery/read receipts, reply, fresh DM file receiver,
reload/history/file reopen and offline/reconnect. Results pending.

## Core PASS and unlock defect fixed

`run-4.log` exited 0: all expanded room/DM/file flows above passed, zero uncaught
page errors. `run-5` found a **production** same-page unlock defect: the new lock
teardown disconnected the transport, but AppView's once-per-page bootstrap never
reconnected it. In shared `AppView.svelte`, transport/profile/room initialization
now runs on each unlock in an untracked effect; delayed mailbox startup captures
the owning identity session. One-time browser setup remains one-time.

Current-source rebuild, full check, and focused review-fixes/DM ownership/
invitations regression command passed (exit 0), log
`/tmp/opencode/cross-feature/unlock-build-check-tests.log`.

`run-7.log` exited 0 after that fix and confirms all core flows again, **plus**:
- UI Lock/Logout makes the formerly downloadable plaintext blob URL unfetchable;
  same-page password unlock restores exact attachment bytes and live DM delivery.
- UI encrypted backup export, backup-passphrase open, account-password identity
  replacement on Carol's browser, reload/unlock, restored DM text and exact file.
- Manual device-sync pairing was only submitted in run-7; completion is still
  pending, and is not claimed by that exit code.

Quick-send in `quick-1` and `quick-2` passed actual protected signaling, exact
183,600-byte download and one-time host closure. Quick-call guest peer presence
was observed, but selector mistakes stopped control checks. A real current-source
SFU is now available as `security-v2-cross-sfu`, host port 13000, RTC 42000–42100;
future quick runs use `SFU_URL=ws://127.0.0.1:13000` rather than the absent fallback.

## Final results — PASS

Final current-source runs **`run-10.log` and `quick-5.log` both exited 0**.
Logs are under `/tmp/opencode/cross-feature/`. The durable test implementation is
`frontend/scripts/test-cross-feature.mjs`. It serves the release-enabled production
bundle, launches separate Chromium processes (not just tabs), drives real UI,
and connects to the real Go relay and TypeScript SFU. No application-module
imports, decrypted signaling injection, bridge or mock transport are used.
TLS passthrough and `/api` HTTP forwarding only expose the real relay locally.

### Executed main run (`EXTENDED=1`)

1. Alice/Bob independently create password-protected identities through UI;
   Alice creates a room; Bob joins its complete invitation; bidirectional chat.
2. Bob reloads/unlocks: persisted room history and subsequent live message.
3. Alice attaches **131,195 deterministic bytes**; Bob receives the actual app's
   file descriptor, clicks Download file, then Download; bytes match exactly.
4. Fresh Carol joins later, gets history and the historical file descriptor,
   downloads exact bytes through app signaling, then reloads and reopens locally.
5. Ordinary room call: two joins, camera preview/start, receiver's non-mirrored
   remote video has a live track and decoded frames (`videoWidth > 0`), camera
   off, both leave. Real SFU; synthetic Chromium media devices.
6. First-contact DM initiated through room user menu. Sender observes delivered
   receipt, receiver opens DM, sender observes read receipt; bidirectional chat.
7. Fresh DM file receiver downloads exact bytes using the normal app flow.
8. DM reload/unlock restores history and opens the authenticated local file.
9. **Cold offline PWA**: navigate receiver to `about:blank` to destroy existing
   sockets, disable network, navigate to cached `/app`, unlock, open DM history
   and exact attachment. Merely setting Playwright offline is insufficient to
   prove existing WebSockets have stopped, so the document is destroyed first.
10. Alice sends while Bob is offline; Bob enables network, reloads/unlocks,
    receives that message and replies live. This validates sender-online
    history/reconnect delivery, not the optional relay mailbox's retention.
11. UI Lock/Logout revokes the published plaintext attachment blob URL (fetch
    fails). Same-page unlock, reopen exact file, and live DM send all pass.
12. UI encrypted backup export (message plaintext absent from downloaded bytes),
    backup-passphrase open and account-password **Replace everything** in Carol's
    browser; unlock, restored DM history and exact attachment pass.
13. Device-sync full manual capability code, real source/target pairing,
    account-password Unlock and import, successful-transfer screen, Continue,
    unlock after identity replacement, restored DM history and exact file pass.
14. Zero uncaught page errors; no `dropped undecryptable` storage warnings.

### Executed quick run (`QUICK=1`)

- Quick-send protected link: host selects one-time sharing and file; independent
  receiver accepts and downloads **188,000 exact bytes**; host displays
  `Delivered · this link is closed.` (The earlier checkpoint's 183,600 was an
  inaccurate prose count; the final payload is 47 bytes repeated 4,000 times.)
- Quick-call: both join as guests, reciprocal peer presence, microphone
  mute/unmute, camera preview/start, remote live synthetic video with decoded
  frames through real SFU, camera off and both leave.
- Zero uncaught page errors or undecryptable-row warnings.

## Additional production fix from final lifecycle checks

`run-8` reached the password-gated sync import but the harness initially failed
to fill that password. The browser log also exposed **a real export bug**:
`sync.svelte.ts` exported raw, at-rest-encrypted watermark rows. Import then
sealed those envelopes again, and subsequent reads dropped undecryptable rows.
The shared exporter (used by backup and sync) now opens rows with
`STORE_SPECS.watermarks`, like the other encrypted stores. A regression in
`sync.test.ts` creates a real armed identity, writes a sealed watermark, drives
the actual source export request and asserts the exported row is plaintext
logical data without a storage envelope. Final browser run passes both restore
paths with storage corruption warnings treated as failures.

The other production fix is the per-unlock AppView transport initialization
described above. Only the following shared source changes were made in this
pass, alongside the new harness/document; surrounding changes belong to prior
work and were preserved:

- `frontend/src/lib/components/AppView.svelte`: import `untrack`, per-unlock
  initialization/session-guarded mailbox start, separate pending-room join effect.
- `frontend/src/lib/transport/sync.svelte.ts`: opened watermark export.
- `frontend/src/lib/transport/sync.test.ts`: encrypted watermark export regression.

## Verification commands and evidence

After the AppView fix, `npm run build && npm run check && npx vitest run
src/lib/transport/review-fixes.test.ts src/lib/transport/dm-ownership.test.ts
src/lib/room-security/invitations.test.ts` passed: **19 tests / 3 files**, full
check **0 errors / 0 warnings** (`unlock-build-check-tests.log`).

After the watermark fix, `npx vitest run src/lib/transport/sync.test.ts
src/lib/transport/backup-restore.test.ts && npm run check && npm run build`
passed: **59 tests / 2 files**, full check **0 errors / 0 warnings**
(`watermark-tests-check-build.log`). Vitest emits fake-indexeddb asynchronous
cleanup diagnostics but exits successfully. The prior whole-suite baseline is
1,719 tests / 165 files; that whole suite was not re-run by this pass.

Build commands used `node:22-bookworm`, working directory `/work/frontend`,
bind `/tmp/opencode/cross-feature/current:/work`, and read-only volume
`awful_sfu_node_modules:/work/sfu/node_modules`. Refresh modified sources into
that isolated tree before rebuilding. Enable its gate with a substitution that
matches the typed declaration, `s/ROOM_SECURITY_V2_RELEASED: boolean = false/
ROOM_SECURITY_V2_RELEASED: boolean = true/`; **shared gate remains false**.

Exact final browser commands (run from repository root):

```sh
docker run --rm --network host --ipc=host \
  -v /home/flaggzz/repos/awful.chat:/repo:ro -v /tmp/opencode:/work \
  -e PLAYWRIGHT_MODULE=/work/security-v2-browser/node_modules/playwright \
  -e APP_DIST=/work/cross-feature/current/frontend/dist \
  -e RELAY_MULTIADDR=/p2p/12D3KooWKxKbUJjJHZXHxVbQSzDb9f3UYDG9VCXasJ1gWx5jceXH \
  -e RELAY_TLS_KEY=/work/cross-feature/key.pem \
  -e RELAY_TLS_CERT=/work/cross-feature/cert.pem \
  -e EVIDENCE_DIR=/work/cross-feature -e EXTENDED=1 -e TRACE_APP=1 \
  -e SFU_URL=ws://127.0.0.1:13000 -w /repo/frontend \
  mcr.microsoft.com/playwright:v1.58.2-noble node scripts/test-cross-feature.mjs \
  > /tmp/opencode/cross-feature/run-10.log 2>&1

docker run --rm --network host --ipc=host \
  -v /home/flaggzz/repos/awful.chat:/repo:ro -v /tmp/opencode:/work \
  -e PLAYWRIGHT_MODULE=/work/security-v2-browser/node_modules/playwright \
  -e APP_DIST=/work/cross-feature/current/frontend/dist \
  -e RELAY_MULTIADDR=/p2p/12D3KooWKxKbUJjJHZXHxVbQSzDb9f3UYDG9VCXasJ1gWx5jceXH \
  -e RELAY_TLS_KEY=/work/cross-feature/key.pem \
  -e RELAY_TLS_CERT=/work/cross-feature/cert.pem \
  -e EVIDENCE_DIR=/work/cross-feature -e QUICK=1 -e TRACE_APP=1 \
  -e SFU_URL=ws://127.0.0.1:13000 -w /repo/frontend \
  mcr.microsoft.com/playwright:v1.58.2-noble node scripts/test-cross-feature.mjs \
  > /tmp/opencode/cross-feature/quick-5.log 2>&1
```

Infrastructure preserved for coordinator continuation:

- `security-v2-cross-relay-isolated`: `golang:1.26-bookworm`, `go run .` in
  `/src`, read-only repo `relay:/src`, `awful_dev_gomod:/go/pkg/mod`, published
  `18080:8080`, `18081:8081`. Get PeerID from container startup logs if restarted.
- `security-v2-cross-sfu`: `node:22-bookworm`, host network, read-only repo
  `sfu:/src` and `awful_sfu_node_modules:/src/node_modules`, command
  `./node_modules/.bin/tsx index.ts`, environment `SFU_PORT=13000`,
  `SFU_RTC_MIN_PORT=42000`, `SFU_RTC_MAX_PORT=42100`.
- Playwright installed with `npm install --prefix /tmp/opencode/security-v2-browser
  playwright@1.58.2`. Local self-signed TLS certificate/key for relay.example.test;
  browser resolver maps that name to loopback and ignores local certificate errors.
- Existing `awful-dev-*` containers were preserved. No commits/push/deploy.

## Remaining scope and release handoff

The requested available cross-feature browser validation is complete. These
results are **multiple independent Chromium processes on Linux**, not a Firefox/
WebKit compatibility matrix. No physical mobile device or native installed-PWA
host was available. Real microphone/speaker quality, camera hardware, native
share-sheet/OS background suspension, cross-network NAT/TURN behavior and physical
QR scanning remain device/environment checks. Calls used real SFU transport and
synthetic media; microphone controls were verified, not audible output quality.
The sync path exercised manual full-capability pairing and identity replacement,
not every merge/cancel variant. Ordinary-room and quick calls were exercised;
DM-specific call UI was not separately exercised. No release flag change is made
by this validation owner; coordinator can make the final readiness decision using
this evidence and the other completed security-v2 handoffs.
