# Wave 3 lifecycle handoff

Status: coordinator-owned after the agent stopped at its usage limit. No commits.
Read active coordination wave, final DM review, previous file handoff, git status.
Preserving existing uncommitted work. Scope is current wave lifecycle files only.

## Plan / resume

1. Inspect receive dispatch and existing integration harnesses; add deferred
   verification/storage/adoption regressions exercising application dispatch.
2. Fix concrete ownership gaps; review encrypted restart/reseed/OPFS recovery.
3. Run focused Docker node22 tests and documented full type check with SFU volume.
4. Review owned diff and record actual evidence and unresolved paths here.

## Verified fixes — 2026-09-27

- Deferred file inventory cannot announce or populate the next identity's cache
  after attachment-session reset. Inventory cache stamps are captured before reads.
- File authorization/signaling rechecks the session after asynchronous lookups.
- Download persistence, legacy inline adoption and reseed completions carry
  session guards through attachment storage commits. Received/sent attachment
  inserts use the existing message-operation identity guard as well.
- Attachment inserts/status/data patches now use guarded transactions that abort
  on identity lock, with ownership checks after asynchronous encryption.
- Found and fixed a storage integrity race: download persistence mutated the clear
  status of an already sealed record when seeding advanced concurrently. Status is
  authenticated metadata; it now reopens/reseals the latest row instead.
- Added deferred-inventory reset regression, deferred-encryption revocation tests
  for insert/status/data, and a concurrent seeding/download decryptability test.

Validation: 66 tests across storage, file announcements/access, encrypted transfer,
DM ownership/security passed. Full type checks passed with zero errors/warnings.
Storage corruption/migration tests emit expected diagnostics. Initial check caught
two `any` index typings in new transaction callbacks; corrected and checked again.
Locked OPAQUE dependency restored using pnpm@10.28.0 before final validation.

Remaining: complete application-dispatch and browser file/DM flows, large-file
restart/reseed on actual OPFS, and final cross-feature lifecycle review. This
checkpoint closes the concrete races above, not all end-to-end lifecycle coverage.
