# Tasks

## Wave 1 — file-disjoint implementation

1. **SFU auth/config** — `sfu/**`, `frontend/src/lib/transport/mediasoup*`, `frontend/src/lib/transport/types.ts`, and only the minimal call/device-key files required to pass signing key material. Implement nonce handshake, tests, and robust numeric env parsing.
2. **Relay invite oracle** — `relay/invite.go`, `relay/invite_test.go`. Move global admission before lookup/validation and update tests/comments.
3. **Invite UI/parser/accessibility** — `frontend/src/lib/invite*`, `frontend/src/lib/room-code*`, `frontend/src/lib/components/RoomCreateJoin.svelte`. Uniform parsing, explicit short-code failure/legacy fallback, TTL expiry/regeneration, labels/errors.
4. **Credential and first-run UX** — `frontend/src/lib/components/IdentitySetup.svelte`, `frontend/src/lib/components/UnlockIdentity.svelte`, identity remembered-password/biometric tests and helpers as needed. Remove bypass and improve onboarding/a11y.
5. **External-media privacy** — `frontend/src/lib/media-prefs*`, `frontend/src/lib/components/SettingsDialog.svelte`, settings media component(s), remote avatar/GIF/preview render/fetch files and tests. Default off, preserve local content, blocked UX.
6. **Oversized send recovery** — shared outgoing validation helper plus room/DM/reply/floating composer/send files and tests, excluding files owned above. Convert final oversized serialized text to `.txt`; preserve drafts/attachments/errors.

## Wave 2 — integration/fixes

Resolve only concrete compile/test failures and scope seams, serialized where files overlap. Run all required package checks.

## Wave 3 — independent review

Parallel read-only correctness/security review across SFU, relay/invites, and frontend privacy/credentials/messaging. Convert FAIL findings into file-disjoint fixes and re-review to PASS. Consolidate in `review-summary.md`.
