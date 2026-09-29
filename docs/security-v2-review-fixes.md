# Final review fixes — 2026-09-28

## Final closure — 2026-09-29

R1–R4 implementations below are complete. Their regressions (batch ownership
repair, deferred lock/archive teardown, stale sends, encrypted plugin image
restoration and descriptor retention) pass in the final enabled **1722-test**
suite; full check and production build pass on exact shared source. Applicable
real UI room/DM/files/lock/backup/sync flows passed afterward as documented in
`security-v2-cross-feature-final.md`. Plugin image checks are host API/real crypto
tests, not a separate browser plugin UI run. Release is enabled locally; see
`security-v2-release-validation.md`. Earlier pending entries below are history.

## Resumed full-suite verification

The full regression run exposed a real identity/storage import cycle introduced
by eager lock subscriptions. Moved the shared notification registry into the
dependency-free `identity/lock-events.ts`; identity still re-exports the public
subscription API. Updated obsolete Workbox and quick-call test mocks for the
current precache controller and guarded invitation persistence.

Final command: full `npx vitest run --reporter=dot && npm run check` in the
documented Node Docker environment exited 0. All 1,719 tests across 165 files
passed. Log: `/tmp/opencode/security-v2-final-regression-4.log`.
Cross-feature browser validation remains pending and LAST. Release gate unchanged.

Owner: `ses_f158bf703ffe83jCZZdlvCH3Qg`. All prior owners finished per coordinator.
Read final review, coordination, and `git status --short` before editing. Existing
uncommitted/staged work is preserved. No commits/push/PR; release gate stays false.
Cross-feature browser validation remains LAST and is not part of this execution.

## Initial checkpoint

- R1 batch attachment ownership: inspecting current application dispatch.
- R2 lock teardown/invalidation: pending integrated implementation/regressions.
- R3 async operation/storage fences: pending implementation/regressions.
- R4 encrypted plugin image resolution: pending implementation/regressions.
- Focused meaningful regressions and full type checks: not yet run.
- Final review closure evidence: pending actual results.

Commands completed: `git status --short` (0; existing large security rollout diff,
profile.test.ts staged), repository AGENTS.md glob (none found).

## Integrated implementation checkpoint

- R1: shared live/batch reconciliation reads the stored admitted descriptor,
  repairs missing/partial owning rows, including duplicate batches.
- R2: identity lock invokes application teardown synchronously, invalidates
  conversation opens and buffered history, aborts/reset files and clears URLs/state.
  Added restore post-disposal cancellation check.
- R3: room/file/plugin sends capture session object guards; message/watermark
  writes and async publication are guarded. Invitation import and AppView join
  continuations capture their initiating session. Default storage guards capture
  the lock epoch before sealing rather than only observing a later transaction.
- R4: encrypted image rows use authenticated local restoration/transfer URLs and
  full descriptors on download requests; ciphertext is never returned as an image.
- First full check command: `docker run --rm -v /home/flaggzz/repos/awful.chat:/repo
  -v awful_fe_node_modules:/repo/frontend/node_modules
  -v awful_sfu_node_modules:/repo/sfu/node_modules -w /repo/frontend node:22-bookworm
  npm run check > /tmp/opencode/security-v2-review-check.log 2>&1` — exit 0.
  This precedes the final guards/tests; repeat after completing regressions.
- Unfinished: focused regressions, final checks, closure documentation. No browser
  checks started and release gate unchanged.
