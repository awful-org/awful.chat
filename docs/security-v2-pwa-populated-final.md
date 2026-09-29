# Populated bundled PWA upgrade validation — 2026-09-28

## Completed — populated upgrade and local archive recovery verified

The completed `/tmp/opencode/cutover-populated-archive.log` confirms authentic
old-app UI data creation, failed-precache recovery, two-tab cutover in 300563 ms,
byte-for-byte unchanged non-telemetry database rows, and original-password unlock.
The upgraded archive displays the saved room/message and downloads the exact
original attachment, including after cold offline startup. The next ordinary
update waits for acceptance and activates in 1032 ms. No uncaught page errors.
This closes populated-data PWA validation; cross-feature testing remains last.

## Prior continuation checkpoint — archive fix implemented, verification in progress

No previous harness process/container was running. The prior continuation log
`/tmp/opencode/cutover-populated-final.log` finished with attachment ciphertext
inequality: the rejected join still ran combined hydration/reseeding.

Expanded authorized scope now includes AppView, transport/files and archive
helpers/tests. Added a pre-relay local archive open branch; AppView mounts an
inert `LegacyArchive.svelte` instead of ChatView (so its plugin/media/composer
effects never mount). Archive hydration reads local attachment bytes only,
never constructs/uses a transfer transport, does not reseed or mutate storage.
Legacy write APIs and seen-marker writes are blocked. Secure networking's
legacy admission rejection is preserved. Shared release gate remains false.

Tests/check logs: `/tmp/opencode/pwa-bundled/archive-{tests,check}.log`.
Isolated current sources refreshed from current working frontend; only its gate
is enabled. Old immutable sources/dist remain untouched.

### Verification checkpoint / exact restart commands

- Isolated `npm run check`: zero errors/warnings; `archive-check.log`.
- Isolated gate-enabled production build: passed; `archive-build.log`.
- Archive + PWA regressions: **10 passed** (6 archive, 4 cutover);
  `archive-tests.log`. Earlier pre-release lifecycle suite also passed (4).
- Current real-browser run container: `security-v2-populated-archive`.
  Log: `/tmp/opencode/cutover-populated-archive.log`.
  Check `docker ps` and this log before starting any repeat.
- Archive uses plain-text rendering and local download links, deliberately
  never mounting MsgRender/plugin/watch/composer effects. The global action
  palette and pending plugin confirmation are unavailable while an archive is
  selected; Close archive restores ordinary app controls. Background inactive
  participant cleanup skips archived rooms, preserving their original records.

```sh
# Refresh isolated CURRENT only (old is immutable).
tar --exclude=node_modules --exclude=dist --exclude=.pnpm-store -cf - frontend sfu/auth.ts | tar -xf - -C /tmp/opencode/pwa-bundled/current
sed -i 's/ROOM_SECURITY_V2_RELEASED: boolean = false/ROOM_SECURITY_V2_RELEASED: boolean = true/' /tmp/opencode/pwa-bundled/current/frontend/src/lib/room-security/invitation-release.ts
docker run --rm -v /tmp/opencode/pwa-bundled:/work -v /tmp/opencode/pwa-bundled/deps:/work/current/frontend/node_modules -v awful_sfu_node_modules:/work/current/sfu/node_modules:ro -w /work/current/frontend node:22-bookworm sh -c 'npm run check > /work/archive-check.log 2>&1 && npm run build > /work/archive-build.log 2>&1'
docker run --rm -v /tmp/opencode/pwa-bundled:/work -v /tmp/opencode/pwa-bundled/deps:/work/current/frontend/node_modules -w /work/current/frontend node:22-bookworm sh -c 'npm test -- src/lib/transport/legacy-archive.test.ts src/lib/room-security/pwa-cutover.test.ts > /work/archive-tests.log 2>&1'
# Uses the already-running real relay security-v2-app-invitations-relay.
# If it restarted, get its current PeerID from docker logs and replace below.
docker run --rm --name security-v2-populated-archive --network host --ipc=host -v /home/flaggzz/repos/awful.chat:/repo:ro -v /tmp/opencode/security-v2-browser:/harness:ro -v /tmp/opencode/pwa-bundled:/builds:ro -v /tmp/opencode:/evidence -e PLAYWRIGHT_MODULE=/harness/node_modules/playwright -e OLD_DIST=/builds/old/frontend/dist -e NEW_DIST=/builds/current/frontend/dist -e RELAY_MULTIADDR=/ip4/127.0.0.1/tcp/8080/ws/p2p/12D3KooWD4RpAZe6mKioPSbgWPUos2tLHCx4w6yig27EamHsE3Gu -e RELAY_TLS_KEY=/evidence/app-invitations-key.pem -e RELAY_TLS_CERT=/evidence/app-invitations-cert.pem -w /repo/frontend mcr.microsoft.com/playwright:v1.58.2-noble node scripts/test-bundled-cutover.mjs > /tmp/opencode/cutover-populated-archive.log 2>&1
```

## Checkpoint — active

Scope: extend the real old/current bundle Chromium harness to cover persisted
room, message, and attachment data across the legacy PWA cutover, then verify
readability through the upgraded app UI after unlock. Prior identity-only
verification is recorded in `security-v2-pwa-final.md`.

Owned files: bundled-PWA harness and this document only. Production changes, if
needed, will be proposed in handoff. Existing local work/stashes are preserved;
no commits, pushes, shared gate changes, or shared dependency installs. Isolated
bundles are under `/tmp/opencode/pwa-bundled`. Cross-feature room/DM/call/sync
integration remains LAST and is outside this validation.

Next: inspect the bundled harness and old app persistence/UI, populate authentic
old-app data where feasible, explicitly label any stored-format fixtures, and
run real Chromium using the existing Playwright Docker dependencies.

## Checkpoint — populated retention passes; UI readability blocked

First populated real-relay run: `/tmp/opencode/cutover-populated-relay.log`.
Old app UI created identity/profile, one room, one text message, one file
message, and one attachment. Downloaded the original text attachment through
the real UI and compared exact bytes. No stored-format fixtures, component
mocks, or modifications to either served bundle/worker were used.

Database v6 counts: identity 2, profiles 1, rooms 1, messages 2,
attachments 1, watermarks 1; other non-telemetry stores empty. All non-telemetry
rows survived cold offline old startup and two-tab cutover byte-for-byte;
cutover took **300615 ms**. Failed precache kept the old offline app available.

**Production blocker:** after current-app unlock, selecting the saved room
shows `Legacy rooms are read-only. Create a secure room to continue.` and backs
out to the start screen. The text message never becomes visible. This is not a
fixture issue: these records were created by the authentic old app UI.

### Proposed production fix — handoff only, not edited here

- `AppView.svelte:560` routes every saved-room selection through `handleJoin`.
- `transport.svelte.ts:3955` requires a relay connection even before loading
  stored history; after loading, it calls `joinStoredRoom`.
- `room-security/room-lifecycle.ts:43` intentionally rejects legacy network
  admission with the release gate enabled. `handleJoin` catches the rejection
  and restores the previous view, hiding the loaded local history.
- Add a real local read-only archived-room open path that does not require a
  relay connection or network admission, while keeping legacy send/join/call
  disabled. Load persisted history and hydrate local attachment URLs there.
  Use local-only attachment hydration rather than the current combined
  `_hydrateAndSeedAttachments`, which also attempts torrent re-seeding.
- Preserve the existing security rejection for legacy networking. Re-run this
  populated bundled harness after rebuilding isolated current with the fix.

The harness now records readability failures while continuing the independent
ordinary-update and cold-offline checks, then exits nonzero if any readability
assertion failed. Final continuation run is active.
