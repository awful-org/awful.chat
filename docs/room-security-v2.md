# Room security v2 implementation status

## Current local release — 2026-09-29

**Security v2 is enabled in the shared source.** The implementation, final source
review fixes, enabled regression suite, and available real-browser integration
checks are complete. Subsequent authorized commits, dev synchronization and PR
status are tracked in `security-v2-pr-handoff.md`. No deployment was performed.
The frontend, relay and SFU must be shipped together.
`security-v2-release-validation.md` records the release decision and exact checks.

### Implemented application behavior

- Ordinary rooms use fresh 256-bit `r2_` capabilities; only derived `rd2_`
  identifiers enter discovery. Stored capabilities are sealed at rest. Creation,
  join/reopen, fragment/custom-protocol input and OPAQUE short-code pairing are
  integrated. Plaintext alias endpoints are retired; no legacy downgrade.
- Noise-authenticated peers prove room membership before room-scoped encrypted
  channels dispatch messages. Channels bind room, peer, session and sequence,
  authenticate bounded fragments and reject replay. Chat, history, profiles,
  plugins, presence, files, sync, quick flows and call signaling use protected
  scopes. Relay rosters do not grant membership.
- DMs derive pairwise capabilities from identity keys; authenticated first-contact
  introduction binds both transport peers. Local `dm-` IDs never serve as public
  discovery capabilities. Unsigned compatibility is limited to admitted historical
  text/reply/reaction rows; live/file/plugin rows cannot use that exemption.
- History preserves original author signatures inside fresh authenticated direct
  channel envelopes. It does **not** add independently identity-signed fresh
  history wrappers. These envelopes are connection-bound, not transferable pubsub
  attestations. Live plugin ephemerals additionally bind authenticated peer to
  signer, enforce signed freshness, and use bounded replay admission.
- File descriptors are signature-bound; torrent bytes and durable DB/OPFS recovery
  data are ciphertext. Authenticated staging publishes plaintext only after full
  validation. Live/batch/history receipt reconciles attachment ownership. Plugin
  image consumers restore authenticated plaintext, never relabel ciphertext.
- Lock invalidates async owners, clears decrypted state, aborts transfers and
  revokes published URLs. Same-page unlock reconnects. Backup and device-sync
  exports open sealed records before encrypted transfer; replacement/import
  boundaries reject stale work. A committed import is serialized, not rolled back.
- SFU admission requires fresh peer and room-capability proofs; legacy rooms are
  refused. Relay discovery is `/awful/rendezvous/2.0.0` only. The one-time PWA
  cutover preserves old data and requires the new client; subsequent updates wait
  normally. Legacy rooms open as inert local read-only archives, without seeding,
  autojoin, composer or plugin effects.

### Completed validation and evidence

- Exact shared enabled source: **1722 tests / 165 files**, type checks with **0
  errors / 0 warnings**, production/PWA build; current Go relay tests and SFU
  **21 tests** plus TypeScript build all passed.
- Final review R1–R4 implementation/regression closure:
  `security-v2-review-fixes.md` and `security-v2-release-validation.md`.
- Real independent Chromium processes, real relay/SFU, actual UI: ordinary-room
  and DM messaging/history/receipts, fresh/live/historical files with exact bytes,
  cold offline reopen, lock/unlock, encrypted backup replacement, manual device
  sync, quick-send, ordinary-room and quick-call synthetic video:
  `security-v2-cross-feature-final.md`.
- Invitation UI/OPAQUE/relay and capability network observation:
  `security-v2-invitation-final.md`, `security-v2-app-invitations-final.md`.
- Actual old/current populated PWA upgrade, byte-identical saved data and local
  archive/offline downloads: `security-v2-pwa-populated-final.md`.
- Browser OPFS recovery/authentication/cleanup and transfer evidence:
  `security-v2-attachment-final.md` and the cross-feature handoff.

### Explicit validation limits

Automated browsers were Linux Chromium processes, not physical devices or a
Firefox/WebKit matrix. Physical QR scanning, native OS protocol/share-sheet/PWA
handoff, mobile background suspension, hardware media quality and cross-network
NAT/TURN remain environment checks. Calls used real SFU and synthetic media;
**DM-specific call UI was not separately tested**. Device sync exercised manual
full-capability replacement, not every merge/cancel UI variant. Plugin image
resolution has host API/real-crypto regression coverage, not a separate final
browser plugin image scenario. Offline DM recovery does not establish optional
relay-mailbox retention. These limits do not imply those checks were run.

## Protocol primitives and historical integration record

<details>
<summary>Archived 2026-09-24 checkpoint — superseded by the current release above</summary>

The following progress statements and unchecked checklist are a historical
snapshot, not current blockers or a description of today's enabled behavior.

### Integration checkpoint (2026-09-24)

The detailed baseline below predates interrupted parallel integration. DM
application adoption, first-contact stream registration, encrypted torrent
seed/download/restore APIs and OPAQUE pairing code have since been added locally.
They are still under integration review; their presence is not release approval.
See `security-v2-coordination.md` and per-agent handoffs for ownership and tests.

Coordinator fixes now prevent capability/fragment links reaching the OG preview
request, bind encryption descriptors into message signatures, pass host-bound
room IDs for plugin cards, and scrub bare capabilities from diagnostics. Focused
regressions pass. The frontend type check passes after WebTorrent typing fixes
and installation of the locked OPAQUE dependency. Five real OPAQUE exchange tests
pass; relay/browser/UI lifecycle validation remains outstanding.

Sync cancellation isolation, quick-session adoption, plugin ephemeral replay,
coordinated legacy/PWA cutover and full browser/device validation remain release
blockers. Ordinary-room v2 release is still disabled. Earlier unchecked gates
below must be reconciled against completed end-to-end verification, not merely
marked complete because an API exists.

This protocol is under construction and is **not enabled for ordinary rooms**.
Device sync now uses protected ephemeral rooms. Existing ordinary-room traffic
is not protected yet. Do not advertise general v2 protection or switch room
generation until the integration gates below pass.

The libp2p transport now exposes opt-in `joinSecureRoom` and `sendSecureRoom`
APIs and registers `/awful/room/2.0.0`. Device sync calls them through
`SecureSyncTransport`; ordinary-room creation does not yet use them.
V2 rooms use verified direct channels, not plaintext pubsub. The channel owns
an ordered receive queue, handshake deadline, byte/frame limits, connection
binding inside ciphertext and replay checking. Peer identity comes from Noise;
these direct envelopes must never be forwarded as independently signed pubsub
messages. V2 peer queries ignore the relay roster for authorization. Closing
connections, leaving rooms and restarting transport invalidates channels.

Secure dialing is now single-flight and discovery triggers verification. Dial
and stream setup have a 30-second budget and reject stale leave/rejoin results.
Backpressure awaits bounded drain instead of immediately dropping the channel.
Mock-stream integration tests cover fragmentation, drain, close and oversize.

The app's room-name, roster, sync digest/batch/completion and live-message direct
copies now use `sendRoom`, which never falls back to plaintext for a v2 ID. A
receive-side scope guard rejects v2 claims on legacy streams and cross-room
claims before dispatch. Profiles select a verified v2 shared room and do not
fall back to legacy delivery in a v2 session. Remaining alternate send paths
still need integration before room creation can enable v2.

V2 call state/presence and watch presence now select only the call's protected
room instead of broadcasting call details into the unrelated room on screen.
Voice SDP/ICE and redial requests use the protected channel for v2 calls, and
the receive dispatcher rejects those requests outside the active v2 call room.
File-seeder announcements and file transport signaling are now restricted to
peers authorized for the file's actual conversation. V2 signaling uses its
protected channel. This does not yet encrypt torrent bytes.

Application messages up to 4 MiB now use authenticated 256 KiB fragments, with
one ordered assembly per channel and a 30-second assembly deadline. No partial
message is dispatched. Total size, offsets, message ID, connection binding and
sequences are authenticated before allocation/reassembly. Close clears assembly.

Real libp2p integration tests now exercise Noise/Yamux/WebSocket peers, encrypted
fragmentation and rejection of peers without a matching capability. V2 rooms no
longer subscribe to legacy pubsub topics. Browser/relay/ICE integration remains.

Still required: complete routing of every room-specific direct send, invitation
and storage adoption, and multi-browser integration tests.

Saved ordinary-room reopen and relay-reconnect now use `joinStoredRoom`: v2
records load a matching stored capability and call `joinSecureRoom`. Missing
or mismatched capabilities never fall back to legacy registration. A malformed
record is skipped during background reconnect so other rooms can still join.
Direct invitation secrets are rejected as local room IDs. Fragment and pasted
capability invitations now import through AppView before opening the public local
room ID; successful import removes the secret from the address bar. Chat copy,
native share and palette copy reconstruct the invitation from the stored secret,
not the public discovery ID. Legacy short-alias requests reject v2 capabilities
before making a network request. Custom-protocol handoff now uses `/r/#%s` in
the manifest; both bare and fragment-form `web+awfl:` capabilities parse without
putting the secret into the HTTP path. Default room creation/cutover and real
browser/OS protocol-registration validation remain unfinished.

Device sync generates a fresh capability, registers only its discovery ID,
and transports requests, export data, acknowledgments and import progress over
verified encrypted channels. Both ends require the pairing-room scope. The
source pins the first full-token-authorized target; the target pins the full
source peer ID. QR and manual copy carry the same complete secret and token;
legacy truncated invitations are rejected before connecting. Source/target
application tests and backup-import tests pass; real two-device browser sync
still needs validation. Room capability storage and backup merge validation
preserve matching local secrets and reject mismatched records.

File chunk crypto and OPFS staging are implemented and tested, including failure
cleanup and delayed publication of authenticated plaintext. Torrent seed,
download and re-seed callers do not yet use that staging.

SFU capability admission is implemented, with real-server tests for missing,
forged, replayed and wrong-peer proofs. Complete application adoption and browser
media-session tests remain; media E2EE remains outside this scope.

## Implemented primitives

DM transport mapping is implemented but not yet adopted by the DM application:
`joinSecureConversation(localId, secret)` retains the existing `dm-` database ID
while registering only the derived v2 discovery ID. Verified message/roster events
map back to the local ID; scoped send, broadcast, membership queries and SFU
admission resolve through the binding. Bindings remain after leave/disconnect so
late scoped sends fail closed. Unit tests cover conflicting bindings and relay
roster injection; a real libp2p test covers bidirectional encrypted delivery under
local DM scopes. All DM join/send/receive, profile and call-scope consumers still
need adoption before this is enabled for actual DMs.

First-contact proof helpers now reuse the sealed-box/identity-signature crypto.
The signed payload has an introduction domain, a fresh 32-byte challenge and
both transport peer IDs; only the intended identity decrypts it. Challenges are
single-use, expire in 10 seconds, and can be cancelled during verification.
Only a verified reply yields the sender DID and derived pairwise capability.
Tests cover replay, connection substitution, forged identities, wrong recipient,
mailbox-content confusion, expiry, size limits and cancellation. The connection
protocol that issues/answers these challenges is NOT wired yet; do not enable
private DM discovery until it and the application lifecycle are connected.

- Canonical `r2_` invitations containing 32 random bytes, unpadded base64url.
- HKDF-SHA256 with salt `awful/room/v2`; separate `discovery`, `membership`,
  `encryption`, and `sfu-signing` labels. Public discovery IDs use `rd2_`.
- HMAC-SHA256 mutual-membership proofs over a JSON array containing domain,
  room, transport-authenticated initiator/responder identities, both fresh
  challenges, and prover role. Proofs alone are not a handshake implementation.
- AES-256-GCM room envelopes. Each envelope has a fresh 32-byte random salt;
  HKDF-SHA256 derives its encryption key using info `awful/room-envelope/v2`.
  The nonce is zero under this unique derived key. No envelope/key may be reused
  for another plaintext. Salt collision probability is that of 256-bit randomness.
- Authenticated metadata: domain, version, room, sender, kind, salt. Strict
  canonical encoding and a 1 MiB plaintext cap before expensive processing.
- Connection-owned three-message mutual authentication state machine, with
  terminal failure and a 10-second pending deadline. Owner must flush finish
  before application traffic. Bounded registry defaults to 256 total sessions,
  32 per connection, with disconnect/leave/clear invalidation and lazy expiry.
- Fixed-memory 64-sequence replay window primitive. Integration must authenticate
  sender/session/sequence before advancing it and must never reset a window for
  a still-valid session ID.

Decryption proves possession of the group key, **not sender identity**. Verify
the existing identity signature before delivery. The encrypted payload must bind
the same room, sender and message kind as its outer header.

## Required integration gates

- [x] Connection-owned mutual handshake with deadlines, admission limits and
  fresh challenges; discard state on disconnect. Verify peers separately per room.
- [ ] Replay admission after cryptographic and sender verification; bounded state,
  defined session lifetime, and signed fresh wrappers for history retransmission.
- [ ] Separate local room references, root secrets and public network identifiers
  in storage and every transport API. No logging of secrets or invitation fragments.
- [ ] Wrap all room traffic, including direct streams, history, profile metadata,
  plugin state, presence, file announcements and call signaling.
- [ ] Handle DMs via authenticated pairwise keys, not their public-DID-derived IDs.
- [x] Authenticate device sync before exporting keys in the application protocol.
- [ ] Real two-device secure-sync validation; cover quick calls/send.
- [ ] Fragment invitations; remove plaintext secret aliases. Short-code pairing
  requires an audited PAKE dependency, independent locator/password, host-enforced
  attempt limits and expiry. No homemade or plaintext fallback.
- [ ] Ciphertext-only torrent distribution with authenticated chunking and protected
  keys/metadata; streaming large transfers without unbounded memory.
- [ ] SFU admission: public verifier bound to opaque SFU ID, fresh signed capability
  and peer authentication. Gate produce/consume; do not derive trust from its roster.
- [ ] Lock/unlock, encrypted backup, restore, device sync, wipe and multi-tab tests.
- [ ] Clean cutover: old history retained locally, no legacy autojoin/downgrade;
  coordinated client/relay/SFU update and explicit PWA update requirement.
- [ ] Malicious relay tests and real multi-browser/device integration validation.

</details>

## Boundaries

The relay still observes groupings of connections. An authorized member can share
the root secret. Exclusion requires rotation. Long-lived root-derived encryption
does not provide forward secrecy. SFU media E2EE and protection from a compromised
frontend distribution host are outside this protocol's guarantees.
Bundled plugins are trusted same-origin frontend code, not sandboxed principals.
This protocol is not post-quantum secure.
