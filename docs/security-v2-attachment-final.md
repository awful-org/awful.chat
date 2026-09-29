# Attachment recovery final validation

Status: agent stopped at usage limit; coordinator revalidated on 2026-09-28.

## Coordinator validation — 2026-09-28

Restored isolated Playwright/esbuild dependencies after restart. First browser run
failed because Vite discovered Node-polyfill shims after page load and invalidated
the dynamically imported WebTorrent bundle. Added those shims to the harness's
explicit optimization list; no production dependency changes.

Re-ran the command below successfully (four PASS lines). Production application
hydration now publishes its owned attachment URL after authenticated restoration.
Verified database descriptor recovery after process restart, original-hash
re-seeding to independent Chromium, wrong-key network rejection, reset cancellation,
URL revocation, locked DB access rejection, late tamper cleanup and recovery wipe.
Room discovery/admission signaling remains a fixture; this does not close whole-app
DM/room file-transfer coverage.
Owns only new recovery script, transport/file/**, files.svelte.ts, room-security/file-* and this file. No commits/push/reset/stash; shared release gate stays false.

Read coordination and wave-3 lifecycle handoff; inspected dirty tree. Existing OPFS test retains descriptor outside browser and does not cover encrypted DB recovery or torrent transfer.

Next: bundle production storage, crypto and WebTorrent modules into isolated Chromium harness; persist encrypted descriptor and ciphertext, restart browser, restore through storage and reseed to second browser. Exercise tamper/cancellation and record exact production boundaries/results here.

## Milestone 1

Integrated Chromium check passed: production createIdentity, putAttachment, browser-process restart, unlockIdentity, getAttachment, restoreEncryptedFile and transfer to independent Chromium via production SimplePeer/WebTorrent/OPFS. 5 MiB + 123 bytes compared exactly; descriptor never retained by runner across restart, only infoHash. Raw IDB row checked for sealing and absence of filename/key. No application modules mocked; runner bridges signaling (not room admission/discovery). Initial harness assertion used wrong sealing field `_sealed`; corrected to actual `_enc`. Isolated Vite dependency scan now targets harness dependencies instead of application HTML.

Command (exit 0, two PASS lines):

```sh
docker run --rm --ipc=host -v /home/flaggzz/repos/awful.chat:/repo -v awful_fe_node_modules:/repo/frontend/node_modules -v /tmp/opencode/security-v2-browser:/harness -e PLAYWRIGHT_MODULE=/harness/node_modules/playwright -w /repo/frontend mcr.microsoft.com/playwright:v1.58.2-noble node scripts/test-attachment-recovery.mjs
```

Next: extend same integrated harness with authentication failure, lock/reset cancellation and wipe checks.

## Milestone 2 — concrete application hydration failure

Direct production transport checks also passed wrong-key network transfer (no plaintext event/URL, ciphertext removed), reset cancellation, URL revocation, locked DB reads, late OPFS tampering and wipe.

Expanded harness to execute production `initFiles` and `_hydrateAndSeedAttachments` with actual storage/identity/WebTorrent; only core transport room signaling/state is substituted with a minimal fixture (no authorized peers; runner signaling bridge remains). This caught a real failure: `Hydration did not publish attachment UI URL`. `initFiles` intentionally ignores transport-owned URLs, but `restoreEncryptedFile` never emitted the authenticated file publication event. Added `downloaded` emission after successful restore so application hydration mints its own URL. Revalidation in progress. No cross-owner changes made.
