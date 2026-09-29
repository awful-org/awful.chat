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

## Next milestone

Commit feature, fetch and merge latest `origin/dev`, resolve integration conflicts,
run complete merged-source frontend suite/check/build and backend tests/builds,
then push and create the PR. Record actual results here as they complete.

## Release and coverage boundaries

Shipping requires coordinated client/relay/SFU cutover. Legacy rooms are retained
as local read-only archives; legacy network admission is intentionally refused.
Prior browser checks used Linux Chromium and synthetic media. Physical devices,
native/QR handoff, cross-network NAT/TURN, hardware media quality and Firefox/WebKit
were not validated. DM-specific call UI was not separately checked. See
`security-v2-release-validation.md` for detailed evidence and remaining limits.
