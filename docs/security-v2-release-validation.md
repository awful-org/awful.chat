# Security v2 release validation — complete

Subsequent authorized branch/commit/dev-sync/PR work is tracked in
`security-v2-pr-handoff.md`; no-commit statements here are historical.

Owner: `ses_f11d93673fferDH1t4t0IYVtFj`, 2026-09-29. Sole active owner.
No commits, pushes or deployment; preserve existing user changes and staging.

**Final decision: local release enabled and validated.** Shared compiled gate is
true. All results below are completed; initial/next checkpoints retain the
chronology. No active work remains assigned to this owner at handoff.

## Starting checkpoint

Cross-feature real-UI/relay/SFU validation is complete; see
`security-v2-cross-feature-final.md` for evidence and device limitations.
Shared release gate is false; isolated `/tmp/opencode/cross-feature/current`
gate is true. Coordinator full enabled run: **1714 passed, 6 failed in 5 files**
out of 1720 tests (`current/final-tests.log`). Inspected coordination and git
status before edits. Existing changes, `.claude/`, and staged profile test retained.

Failures to investigate: invite gate expectation; pre-cutover room lifecycle;
legacy scope admission; stored-file legacy announcement; two libp2p legacy
error/discovery expectations. Do not disable the gate globally to pass tests.

## Next checkpoints

1. Review six failures against fail-closed production policy; update stale
   fixtures or fix genuine defects in authoritative shared files.
2. Sync edits into isolated enabled copy; full suite, check, production build.
3. Review final handoffs and reconcile coordinator/protocol status; enable shared
   gate only on passing evidence, then validate exact shared source using isolated
   dependency mounts. Record all results here as completed.

Physical-device/media-quality/native handoff and DM-specific call UI are not
claimed by the completed automated browser validation.

## Enabled-copy checkpoint — PASS

All six failures were stale gate-off expectations/fixtures, not production
defects. Changed five test files: invitation approval honors the compiled gate;
room lifecycle and scope default to explicit release-on regressions with separately
labeled legacy-only cases; file announcements use protected room fixtures and
assert shared legacy archives stay silent; DM join tests expect the applicable
fail-closed error and retain no-plaintext assertions. No security check weakened.

`release-tests-check-build.log`: **1722 tests / 165 files passed**, check **0
errors / 0 warnings**, frontend/PWA production build passed (28 precache entries).
Command in Node 22: `npx vitest run && npm run check && npm run build`, isolated
copy and SFU dependency mounts as in the cross-feature handoff. Source comparison
confirmed frontend source identical except the intentional compiled gate; synced
all five changed tests before running. Existing expected negative-test and
fake-indexeddb cleanup diagnostics remain non-failing.

Fresh current shared backend checks also exited 0: Go `go test ./...`
(`release-relay-tests.log`), SFU `npm test && npm run build`
(`release-sfu-tests-build.log`).

Reviewed original audit, final R1–R4 review, fix regressions, populated PWA and
cross-feature closure evidence. R1–R4 are implemented and regression-covered;
fresh DM/history files, lock/unlock, backup/sync are additionally covered through
real UI. Plugin image authentication is covered by host API/real crypto tests,
not a separate final browser plugin UI scenario. No unresolved must-fix finding
established in this release pass. Next: enable shared compiled gate and run exact
shared-source suite/check/build with isolated dependencies; reconcile status docs.

## Exact shared-source checkpoint — PASS

After setting the shared compiled gate true, the following command exited **0**:

```sh
docker run --rm \
  -v /home/flaggzz/repos/awful.chat:/repo \
  -v /tmp/opencode/cross-feature/current/frontend/node_modules:/repo/frontend/node_modules \
  -v /tmp/opencode/cross-feature/current/frontend/dist:/repo/frontend/dist \
  -v /tmp/opencode/cross-feature/current/frontend/public/third-party-notices.txt:/repo/frontend/public/third-party-notices.txt \
  -v awful_sfu_node_modules:/repo/sfu/node_modules:ro \
  -w /repo/frontend node:22-bookworm \
  sh -c 'npx vitest run && npm run check && npm run build' \
  > /tmp/opencode/cross-feature/shared-release-tests-check-build.log 2>&1
```

Results: **1722 tests / 165 files passed**, full check **0 errors / 0 warnings**,
production bundle and PWA worker built successfully, **28 precache entries**.
The source mount is authoritative shared source, not another copied snapshot.
Dependencies, dist and regenerated notices were redirected to isolated mounts.
No additional application behavior changed after the completed main/quick
browser runs: only release-aware tests and the shared compiled gate changed.
The same enabled behavior had already been exercised by those browser runs.

Backend repeat commands (both exit 0):

```sh
docker run --rm -v /home/flaggzz/repos/awful.chat/relay:/src:ro \
  -v awful_dev_gomod:/go/pkg/mod -w /src golang:1.26-bookworm go test ./...
docker run --rm -v /home/flaggzz/repos/awful.chat/sfu:/src \
  -v awful_sfu_node_modules:/src/node_modules -w /src node:22-bookworm \
  sh -c 'npm test && npm run build'
```

SFU: **21 passed, zero failed**. Relay: package tests passed. Logs are
`release-sfu-tests-build.log` and `release-relay-tests.log` in the evidence folder.
Final shared gate and test edits were synced to the isolated tree, keeping true.

## Final review and handoff

- Reconciled authoritative completion in `security-v2-coordination.md` and
  `room-security-v2.md`; explicitly archived old blockers/ownership statements.
  Added closure pointers to final review and review-fixes documents.
- `git diff --check` reports pre-existing generated third-party license text
  whitespace. Excluding `frontend/public/third-party-notices.txt`, the check
  passes. That existing generated file was preserved, not reformatted.
- User/profile changes, staged `frontend/src/lib/profile.test.ts`, `.claude/`,
  dependency files and existing dev infrastructure preserved. No commits,
  pushes, deployment or subagents created by this pass.
- No unresolved must-fix from the six failures or final review remains. The
  release is a **local completed implementation**, not a deployed service or an
  independent security certification. Future shipping needs matching client,
  relay and SFU versions for the intentional legacy refusal.

### Remaining physical/environment coverage

Real UI checks used independent Linux Chromium processes and real relay/SFU,
with synthetic media. No physical mobile/native-PWA host, actual QR scanning,
OS protocol/share-sheet handoff, hardware audio/video quality, cross-network
NAT/TURN or Firefox/WebKit matrix was validated. Ordinary-room and quick calls
passed; **DM-specific call UI was not separately exercised**. Manual full-code
device-sync replacement passed, not every merge/cancel UI variant. Plugin image
restoration has host API/real-crypto regressions, not a separate final browser
plugin UI scenario. Optional relay mailbox retention is not established by the
sender-online history/reconnect check. These are explicit coverage limits, not
claims of completed device testing.
