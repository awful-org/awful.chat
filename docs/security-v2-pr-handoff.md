# Security v2 PR handoff

## Current checkpoint — 2026-09-29

User authorized a separate branch, commits, synchronization with `origin/dev`,
push and PR targeting `dev`. This supersedes historical no-commit/no-push
instructions in the implementation handoffs. No deployment authorized or performed.

- Created `feat/room-security-v2` from local `dev` before committing or merging.
- Include completed security implementation, enabled release gate, documentation,
  browser scripts, regression tests and pending profile fixes.
- Preserve and exclude unrelated untracked `.claude/` and `.pnpm-store/`.
  Both existing recovery stashes are retained.
- Reviewed tracked diff inventory and new source/docs/scripts. Credential-pattern
  scan of new documentation/scripts found only explicit browser-test passwords.
- Removed accidental pnpm `allowBuilds` placeholder strings; existing pinned-pnpm
  `onlyBuiltDependencies`/`ignoredBuiltDependencies` policy is retained.
- Prior exact-source baseline: frontend 1722 tests / 165 files, check/build pass;
  SFU 21 tests/build pass; relay tests pass. Post-merge checks are still pending.

## Feature and dev-sync milestone — complete

- Feature commit: `37aca8f` (166 files), including profile fixes.
- Fetched `origin/dev` at `7bffd478b88b5f2f43db6bfa983d83ca2751e93b`.
- Merge commit: `697cdc8`; no textual conflicts. Reviewed overlapping automatic
  merges in AppView, ChatView, WebTorrent and voice transport. Upstream download
  scheduling/serving budgets and media/UI fixes coexist with protected routing.
- Full staged added-line credential scan found only explicit test passwords.
  Diff whitespace check passed except retained generated third-party license text.
- Post-merge full frontend and backend checks passed as recorded below.

## Exact merged-source validation — PASS

Validated application source at merge commit `697cdc8`, with release gate true.
Only documentation changed afterward. All three commands exited 0:

```sh
docker run --rm -v /home/flaggzz/repos/awful.chat:/repo \
  -v /tmp/opencode/cross-feature/current/frontend/node_modules:/repo/frontend/node_modules \
  -v /tmp/opencode/cross-feature/current/frontend/dist:/repo/frontend/dist \
  -v /tmp/opencode/cross-feature/current/frontend/public/third-party-notices.txt:/repo/frontend/public/third-party-notices.txt \
  -v awful_sfu_node_modules:/repo/sfu/node_modules:ro \
  -w /repo/frontend node:22-bookworm \
  sh -c 'npx vitest run && npm run check && npm run build'
docker run --rm -v /home/flaggzz/repos/awful.chat/relay:/src:ro \
  -v awful_dev_gomod:/go/pkg/mod -w /src golang:1.26-bookworm \
  sh -c 'go test ./... && go build -o /tmp/awful-relay .'
docker run --rm -v /home/flaggzz/repos/awful.chat/sfu:/src \
  -v awful_sfu_node_modules:/src/node_modules -w /src node:22-bookworm \
  sh -c 'npm test && npm run build'
```

- Frontend: **1737 tests / 166 files passed**; check **0 errors / 0 warnings**;
  production/PWA build passed, 28 precache entries.
- SFU: **21 tests passed**, zero failures; TypeScript build passed.
- Relay: all package tests passed; binary build passed.
- Logs: `/tmp/opencode/security-v2-pr-{frontend,sfu,relay}.log`.
- Existing negative-test/fake-indexeddb diagnostics and production chunk-size
  advisory remain non-failing. No integration regressions required code changes.
- Browser evidence in earlier handoffs predates this dev merge; browser flows
  were not rerun as part of the PR workflow.

## Publication checkpoint

Validation complete; push and PR creation are the next authorized actions.

## Release and coverage boundaries

Shipping requires coordinated client/relay/SFU cutover. Legacy rooms are retained
as local read-only archives; legacy network admission is intentionally refused.
Prior browser checks used Linux Chromium and synthetic media. Physical devices,
native/QR handoff, cross-network NAT/TURN, hardware media quality and Firefox/WebKit
were not validated. DM-specific call UI was not separately checked. See
`security-v2-release-validation.md` for detailed evidence and remaining limits.
