# Quick sessions security v2 handoff

Status: resumed 2026-09-24; owned integration implemented, validation/review in progress. Exclusive
ownership: quick-session modules/components/tests and this file. No commits,
package changes, or edits to core transport/invitation/storage/UI owner files.

Read coordinator, audit, files and invitations handoffs; inspected dirty tree.
No previous quick implementation or handoff existed at resume. A3 and quick-call
portion of A4 remain open until integration and adversarial tests pass.

Required integration: validated capability joins, authenticated membership and
room-scoped sends/receives; encrypted torrent seed/download descriptors; never
reseed downloaded plaintext; protected call signaling and SFU authorization.

Validation uses coordinator's Docker frontend/SFU dependency volumes. No tests
run at this checkpoint. Cross-owner caller contracts will be recorded here.

## Milestone 2 — protected flow integration

- [x] Replaced legacy quick-code test assumptions with exact v2 capabilities;
  invalid/legacy/public-ID launches fail closed before network or storage setup.
- [x] Quick send requires authenticated room membership AND matching event scope.
  Descriptor shape, encryption metadata, hash and same-hash substitution checks
  precede both UI admission and torrent signaling; unrequested hashes cannot dial.
- [x] Explicit protected announcements after encrypted seed and authenticated
  download. The file API does not announce seedEncryptedFiles automatically.
  Downloaded plaintext never enters any seed or lookup API.
- [x] Retained-ciphertext references cleaned on teardown; stale connect/seed/event
  continuations cannot repopulate UI or send into a replacement session.
- [x] Quick call imports the capability into disposable storage, joins the derived
  public ID, checks the returned mapping and verifies actual core call success.
  ChatView now receives quickCall.roomCode, never the capability.
- [x] Preparation/join/cleanup serialized, with generation checks after awaits;
  hangup during pending room join prevents late media entry/session resurrection.
- [x] One-time/Save-Data receivers suppress ciphertext reannouncement and disconnect
  completed transfer peers; one-time host closes file connections on valid ack.
  Wording no longer promises only one receiver when concurrent transfers exist.

Initial Docker `vitest run src/lib/quick`: **48 passed** (18 send, 22 call,
8 storage). More integrated ciphertext and storage-race tests being added.
Full `npm run check` currently reports 6 errors outside owned files:
missing @serenity-kit/opaque plus removed legacy invite exports used in
frontend/src/lib/invite.test.ts. No quick-file diagnostics; not a passing check.

## Cross-owner launch contract

AppView/App.svelte owners: launch `/qs` or `/qc` without a fragment to mint a
new capability. To invite/join, use only `/qs#<r2_capability>` or
`/qc#<r2_capability>` with exact case-sensitive `parseRoomSecret` input.
Never use generateQuickCode/formatQuickCode, uppercase, strip punctuation,
put capability in a path/query, or pass an rd2_ public ID as an invitation.
Inside QuickCall, ChatView gets the **derived rd2_ roomCode**. The original
capability is used only for the fragment link and sealed disposable room row.

Core call/SFU contract inspected: ordinary joinRoom loads storedRoomSecret;
the shared transport installs `_video.setRoomAdmission(...sfuAdmission...)`.
Mediasoup requires a room proof for rd2_ and maps to rs2_ admission. QuickCall
must continue through that stack, never call a raw legacy SFU join. Voice and
presence use core's protected room signaling. SFU media E2EE is not claimed.
