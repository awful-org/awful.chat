# Invitations / PAKE / UI handoff

Owner session: `ses_f314d6225ffenu0O8qAdxqdQLn`. Active; do not duplicate this owner.
Ownership follows `security-v2-coordination.md`. No commits/push/subagents.

## Milestones
- [x] Read coordination/security specification; inspected dirty tree (existing partial invitation UI must be preserved).
- [ ] Inspect and integrate fresh v2 creation, capability import/share/QR/protocol/launch.
- [ ] Implement explicit shared release gate and clean legacy cutover UI.
- [ ] Establish appropriate maintained/reviewed PAKE dependency or explicitly block release.
- [ ] Test lifecycle/pairing/network secrecy boundaries.

## Cross-owner requests
- Coordinator: shared gate is `ROOM_SECURITY_V2_RELEASED` in `frontend/src/lib/room-security/invitation-release.ts`, initially false, changed only by coordinator at final go-live. `requireRoomSecurityRelease()` guards ordinary creation/import/join UI. No URL/env/localStorage bypass.
- Files owner: ChatView will consume exported encrypted seed/download APIs after inspection; no writes to file-owned files.
- DM/core owner: on cutover (`ROOM_SECURITY_V2_RELEASED`), `joinStoredRoom` and `joinRoom` plus background relay reconnect must reject/skip all ordinary rooms without validated `rd2_` capability. Retain local records/history; do not register legacy codes, and do not fall back after secure join failure. UI imports shared gate from `room-security/invitation-release.ts`. Gate false keeps new ordinary-room UI disabled while transport integration is completed.
- Files owner confirms ChatView/AppView APIs need no direct changes; sendFiles handles seedEncryptedFiles/descriptor adoption in core owner's file.

## Dependency provenance / design
- Selected exact `@serenity-kit/opaque@1.1.0` (MIT), registry publication February 2026, npm provenance and integrity available. README links 7ASecurity whitebox review: https://7asecurity.com/reports/pentest-report-opaque.pdf; underlying opaque-ke has NCC review (2021, fixes in 1.2.0). These reviews are evidence for the dependency, NOT an audit of our integration or every later release.
- OPAQUE registration is entirely LOCAL on inviter, which owns fresh server setup and password record. Relay never receives setup, record, private password, room secret, or derived session key. Join flow transports OPAQUE login only. Independent locator/password; host caps attempts and expires/cancels/single-uses locally even against malicious relay.
- Initial unpinned corepack selected pnpm 12, ignored existing overrides and rewrote lock. Restored only this agent's generated lock changes (lock was clean at entry), retrying pinned pnpm 10.11 to preserve lock/override style.

## Commands / results
- `git status --short`: many existing changes, including owned UI/invite files; preserved.

## Remaining blockers
- Dependency selected and installed; PAKE implementation still pending after repeated transport interruptions. No plaintext alias fallback allowed.
- Overall transport/DM/files integration and browser validation pending other owners.
