# Remediation verification — 2026-09-11

UI follow-up (2026-09-14): U1–U6 implemented; U7 excluded at user request.
See ui-direction-review.md for updated status. The older outstanding-UI notes
below describe the pre-follow-up snapshot.

Final UI verification: frontend check zero errors/warnings, full tests 1,669
passed across 140 files, production build passed, git diff --check passed.

## Follow-up: media default and recovered watch controls

User changed the external-media default to on. Saved off preferences are retained;
settings copy and protocol docs now match. The default-off notes below describe
the initial remediation.

Found a local reconnect/UI mismatch: attemptRejoin retained internal watch intent
while emitting peerLeft, which cleared the UI's watch IDs. Automatic consumption
then restored media without restoring those IDs. Rebuild now retracts tracks
without claiming remote departure. A landed watched video emits transmissionRestored
to refresh the UI's peer/producer IDs and watch presence. Late consume completion
and retries are discarded after watch cancellation or session-generation changes.

Verification: 17 focused tests passed; frontend check zero errors/warnings.
Tests cover retained watch intent during rebuild, new producer IDs restoring stop
controls, and stopping while consume is in flight. The underlying intermittent
disconnect cause has not been established from live diagnostics.

Implemented directly after the user stopped delegation. Changes are uncommitted.

## Delivered

- #2: single-use per-WebSocket nonce, room/peer-bound Ed25519 proof, admission
  acknowledgement, bounded authentication wait, device and quick-session signing.
- #3: blank numeric SFU variables use defaults; malformed and out-of-range
  values fail startup. Explicit Compose probe/diagnostic defaults.
- #4: default-off external media setting, blocked core GIF/avatar rendering,
  no automatic OG requests until opt-in, local attachments preserved.
- #5: remembered credentials cleared/refused with biometric enrollment;
  new setup defaults to no remembered password; typed password fallback.
- #6: global short-invite admission before lookup, hit/miss-independent.
- #7: shared final-text limit converts oversized messages to UTF-8 message.txt;
  room/DM/reply/floating paths covered, attachment-count guard, awaited sends,
  retained drafts/files on rejected sends, visible feedback.
- #8–9: shared join parsing, explicit ambiguous legacy fallback, no expired-alias
  literal join, TTL countdown/regeneration and bounded lookup requests.
- Usability: first-run essentials with expandable detail, setup/unlock/entry
  labels and autocomplete/error improvements.

## Verification

- Frontend check: zero errors/warnings.
- Frontend full tests: 1,665 passed, 139 files.
- Frontend production build: passed.
- SFU build: passed. SFU tests: 20 passed, including browser/server signature
  interoperability (frontend suite), forged/unsigned/replayed admission,
  authenticated reconnect/live-incumbent protection, and numeric validation.
- Relay full tests: passed on rerun. Initial run failed the unchanged
  TestCappedRegisterGetsRegisterFailed while waiting for 1,024 frames (got 0).
  That first-run failure was outside invite tests; its root cause is not proven.
- git diff --check: passed.

## Review scope and limits

Parent source review covered auth admission ordering and reconnects, media
rendering/fetch gates, remembered credential storage boundaries, join ambiguity,
and room capture/draft clearing in asynchronous sends. No independent agent
review was run, per the user's instruction. No connected browser was available
for live visual, keyboard, biometric, or multi-device call validation. Composer
recovery has source review and converter tests, not a live end-to-end failure test.

GIF search requests, explicitly opened links, and plugin network access are
outside the media-rendering preference. Large text attachments have ordinary
file-transfer/offline-availability limitations. The frontend and SFU must deploy
together; older clients cannot perform unsigned video joins.

The prior UI-direction audit remains in ui-direction-review.md. Its broader
settings/floating-panel sizing, token, contrast, and motion recommendations are
not implemented in this remediation. Finding #1 remains design-only: device
ownership does not establish room membership or provide SFU media E2EE.
