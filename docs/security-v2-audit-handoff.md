# Security v2 read-only audit handoff

## Resume / ownership
- Audit started 2026-09-23. Read `security-v2-coordination.md` and `room-security-v2.md` first.
- Exclusive write scope: this file. No implementation changes, dependency changes, commits, or subagents.
- Other agents actively own DM/core, encrypted files, and invitations/PAKE. Treat their incomplete adoption as work in progress, not newly discovered defects.
- Coordinator owns cross-cutting fixes after relevant ownership is released.

## Progress
- Documentation and implementation inspection complete for the first audit pass; follow-up validation gates below remain open.
- Audit targets: signature/replay/history contracts; plugin/backup/telemetry/URL secret exposure; alternate plaintext sends; quick sessions; SFU authorization; sync cancellation; PWA cutover.
- Resumed after usage limit; re-read coordination/handoff and inspected transport channel/scope, signature gate, plugin host, quick sessions, SFU admission/consume, sync lifecycle, telemetry and PWA prompt. Working tree has concurrent implementation edits; line numbers below are snapshot references, use function names to relocate.

## Confirmed findings — milestone 1

### A1 — High: source sync export survives cancellation and uses replacement transport (coordinator)
- `frontend/src/lib/transport/sync.svelte.ts:667` `sendExportData`: awaits `exportDatabase`, then reads mutable `_transport` and `_syncToken` at 681/686; batch sends also use global transport. `cleanup`/`cancelSync` (1631/1670) clear globals but do not invalidate pending export jobs.
- Existing async lifecycle defect, now a concrete v2 isolation contract issue: cancellation must revoke authorization for the old export, not just disconnect the current socket. Entry handler's `sourceTransport` equality check is only before the await.
- Repro/test: defer `exportDatabase`, authorize peer P in session A, cancel A, start B, resolve A. Assert no identity/room-capability frame reaches B, no stale job changes B's progress/error or cleans B up. For actual disclosure P must be reachable/authorized in B (same peer can join B); otherwise sends fail but stale UI/cleanup still affect B. Also defer connect/QR creation and cancel: `startSyncServer` uses globals after connect and QR completion repopulates cancelled UI.
- Fix requirement: immutable per-operation transport/token/room/peer plus generation or abort signal checked after every await and before every send/import/cleanup; stale cleanup cannot destroy newer state.

### A2 — High: plugin `sendCard` violates host room binding (coordinator + DM/core after release)
- `frontend/src/lib/plugins/host.ts:75-78` `makeHostApi(..., roomCode).sendCard` drops bound room; `frontend/src/lib/transport/transport.svelte.ts:4383` `sendCard` reads `transportState.roomCode` instead. API promises host-bound room (`plugins/api.ts:100`). Updates already pass room explicitly.
- Existing cross-conversation disclosure defect, not a cryptographic break: pinned/background plugin A calls `sendCard(privatePayload)` while B is open; payload is correctly signed/encrypted for wrong recipients B.
- Repro/test: construct host for room A, switch active room B (also test DM UI), call host.sendCard; assert only A's storage and transport receive it. Pass explicit scope through card send and validate joined scope.

### A3 — High release blocker: quick-send remains legacy trust/plaintext distribution (coordinator)
- `frontend/src/lib/quick/quick-send.svelte.ts` startup 296-365: raw `LibP2PTransport`, `t.send` for file signaling (303), relay roster as membership (334), receiver ignores authenticated channel room (342), `joinRoom(code)` (365). `offerFiles` (375) seeds input plaintext; downloaded callback (327-329) re-seeds plaintext.
- Existing uncovered alternate pipeline, not unfinished encrypted-files agent wiring (quick sessions belong to coordinator). A malicious relay can supply a room peer and receive manifests/plaintext file bytes; no capability admission here. Noise/DTLS protects links, not access from roster-injected endpoints.
- Repro/test: relay injects outsider in quick roster; outsider must receive no offer/signal/data. Inspect seeded bytes for sentinel plaintext. Adopt secure capability + scoped events/sends and encrypted staging, or disable quick-send at v2 cutover until integrated.

### A4 — High release blocker: coordinated legacy/PWA cutover is absent (coordinator)
- `frontend/src/lib/components/ReloadPrompt.svelte:44-46,78-84`: update is dismissible; hourly poll is advisory only. `sfu/auth.ts:33` accepts every non-v2 room without room proof. Quick call `startQuickCall` (`quick-call.svelte.ts:325`) still calls ordinary join with its legacy code.
- Known incomplete release gate, not a newly introduced vulnerability or bypass of `rs2_` proof. Old clients/legacy rooms remain usable unless server admission and client autojoin are explicitly cut over.
- Test old installed PWA + active old tab against updated relay/SFU, offline startup then reconnect, dismissed update, multi-tab upgrade and saved legacy room restore. Require explicit update/legacy refusal without deleting local old history.

## Additional findings — milestone 2

### A8 — Critical confidentiality blocker: invitation fragment leaks through OG preview query (coordinator)
- `frontend/src/lib/components/MsgRender.svelte:597` `firstUrl` preserves `#r2_...`; `linkedUrl` is passed whole to `encodeURIComponent` in the preview-fetch effect at 695-705. Request becomes `/og/preview?url=https%3A...%2Fr%2F%23r2_SECRET`: the secret is now an HTTP query, not a browser-only fragment.
- `frontend/src/lib/media-prefs.svelte.ts:11` enables external-media previews by default. Merely rendering a text message containing a v2 invitation can disclose its root capability to relay/reverse-proxy request logs, even if the message arrived over a protected room/DM channel. The relay can derive membership, encryption and SFU signing material for the invited room. This is an existing generic-preview behavior with a new concrete v2 secret-exposure consequence.
- Repro/test: post `https://<app>/r/#r2_<valid-secret>` as text in a secure conversation, render it with default preferences, inspect outgoing `/og/preview` request. Assert the sentinel capability is absent from ALL outbound URL strings and bodies, including received history renders. No malicious JS or room member action beyond sharing the supported invite link is needed.
- Fix requirement: never request remote previews for capability/pairing links; centrally strip fragments from any preview target before constructing the proxy request, with tests for encoded/nested/custom-protocol invitations. Keep original link only for user navigation/copy. Also audit other URL proxy/plugin/media consumers. This should be resolved before enabling v2 room creation, regardless of invitation fragment parsing correctness.

### A5 — High integration contract: encrypted file descriptor is outside identity signature (coordinator + files/core)
- `frontend/src/lib/types/message.ts` `FileEntry.encryption` now contains the private `EncryptedFileDescriptor` (`room-security/file-crypto.ts`: version/key/id/size/chunkSize). `frontend/src/lib/messaging.ts:73` `canonicalContentV3` signs only each file's `infoHash:size:mimeType:filename`, excluding `encryption` entirely.
- Concrete cross-owner contract issue, not a report that the files agent has not finished its pipeline. A room member forwarding signed history can replace/remove encryption metadata while preserving the original author's valid signature. AEAD failure will normally cause denial of download, not attacker-chosen plaintext under the same torrent hash; stripping metadata can misclassify ciphertext as a legacy file unless receivers enforce encrypted-only v2 records.
- Repro/test: sign a file message, alter each descriptor field or delete descriptor, call `verifyIncoming` in the original room: canonical bytes currently do not change. Require signature rejection of altered descriptors and rejection of plaintext file records in v2 scopes. Introduce an explicit canonical version or a carefully specified compatible extension; cover codec/backup/history round trips and avoid changing legacy verification implicitly.

### A6 — Medium: member can replay another author's signed plugin ephemeral in a fresh channel envelope (coordinator + core)
- `room-security/channel.ts:77-90` correctly rejects replay of an encrypted channel frame and binds sender/session/sequence to fresh membership. It does not deduplicate the signed application payload. `transport/transport.svelte.ts` `PluginEphemeral` dispatch verifies the signature then folds; `plugins/state.svelte.ts:191` `foldUpdate` explicitly exempts ephemerals from ordering and has no seen-ID check.
- Existing application replay gap, distinct from new channel replay protection. Authorized member B can capture A's valid ephemeral and submit it repeatedly in fresh authenticated B envelopes. Receiver attributes update to A from its signature; flood cap is keyed by forwarding peer. Impact depends on plugin reducer (stale playback/cursor/actions), not arbitrary signature forgery.
- Repro/test: deliver A's signed ephemeral once, then same bytes via B's valid channel and after reconnect; assert no second fold. For live-only ephemerals require signer-to-authenticated-peer binding and bounded freshness/ID admission. History legitimately needs original authors distinct from forwarding peer; do not apply live-origin equality to history.

### A7 — Medium hardening gap: diagnostic scrubber does not recognize bare v2 capabilities (coordinator)
- `frontend/src/lib/telemetry/redact.ts:127` `RefTable.scrub` removes URLs, registered room strings and DIDs. V2 transport registers `rd2_` IDs, not `r2_` root secrets; an unregistered bare capability survives `errText` (`telemetry/event.ts:115`).
- Concrete redaction contract gap; no current automatic root-secret-to-error source was confirmed. Do not describe this as proven exfiltration. Add pattern-level scrubbing of capability invitations and sync tokens before truncation; verify all actual error/bundle entry points with sentinel secrets.

## Actual cryptographic guarantees and reviewed non-findings
- `room-security/channel.ts` authenticates group AEAD first, checks Noise remote/local identities, room, membership transcript, session and replay sequence, then assembles bounded fragments. Fresh membership prevents replay across reconnects. Replay window advancement before application identity-signature verification is not by itself a remote outsider attack: channel sender is already Noise/membership-authenticated, and malformed frames close that channel.
- Chat `verifyIncoming` requires sigV3, signer DID equals claimed author, and canonical room/type. History `_handleSyncBatch` verifies original messages independently, limits batch row count, and scopes DM unsigned compatibility to authenticated counterparty's own rows or paired own identity. Live batches currently share this unsigned allowance: review/removal at v2 cutover is a core-owner gate, not a claim of forged signed messages.
- History retransmission uses fresh channel envelopes with authenticated forwarding peer, **not independently identity-signed fresh history wrappers**. This is adequate for direct channel origin/freshness against an outsider but does not satisfy the status document's literal signed-wrapper gate. Coordinator must implement that requirement or document the direct-channel alternative explicitly; never forward these envelopes as self-authenticating pubsub objects.
- `sfu/auth.ts` verifies independent peer-key and room-capability signatures over server nonce/room/peer. `sfu/index.ts` join is checked before installing peer state; produce uses admitted peer's send transport, consume uses a router keyed by admitted room and `canConsume`. No concrete cross-room produce/consume bypass was found in the inspected paths. Legacy acceptance is A4, not an `rs2_` bypass. Real cross-room media-ID negative tests remain required.
- Room capabilities are stored as non-clear fields in sealed room rows (`storage.ts` `putRoom`, `storage-crypto.ts` room specification). `validateStoredCapability` rejects mismatched discovery IDs. Backup export intentionally contains decrypted room records but `downloadBackup` encrypts the full export with passphrase AES-GCM; identity mnemonic is additionally password-encrypted, not a raw signing key. Trusted restore/sync can change local data: it is not network author verification.
- `plugins/host.ts` exposes local room ID, DID and room context, not explicit room-root or identity-private-key methods. Plugins load as bundled same-origin code (`plugins/registry.ts`), **not a sandbox**; hostile bundled plugin code can import session/storage APIs. Treat shipped plugins as trusted frontend code, not independently isolated principals. Plugin storage is plaintext localStorage: do not put capabilities/private descriptors there.
- `room-security/invitation-format.ts` constructs `/r/#r2_...`, rejects path/query secret forms and preserves custom-protocol secret casing. URL fragments avoid HTTP request/referrer exposure but remain visible to frontend scripts/browser history until removed. Browser/OS handoff and early-removal tests remain invitation-owner gates.

## Intended limitations (not vulnerabilities)
- Relay sees membership graph; members can share capability; revocation needs rotation.
- Long-lived capability encryption has no forward secrecy.
- SFU media E2EE and compromised frontend distribution are out of scope.

## Validation / next steps
- Audit method: read-only source inspection, symbol searches and initial `git status --short`. No implementation/test/dependency edits, test runs, builds, browser sessions, commits or subagents were performed. Reproductions above are recommendations, not claims of executed exploitation.
- No `AGENTS.md` was found by repository glob. Existing user/profile/`.claude` work was preserved.
- After owners release files, re-check current implementations against A1-A7 (concurrent edits may already address parts). Coordinator owns cross-cutting changes; core owns transport/signature routing integration; files owns descriptor/codec/staging adoption; invitations owns PAKE/URL/create/reopen adoption.
- Release gates (priority order): **A8**, A1/A2/A5/A6; close A3/A4 alternate-path and cutover gaps; explicitly decide A7 hardening. Verify no v2 content/key reaches raw send/pubsub, torrent public metadata, diagnostics, URL paths/query, or plugin persistent storage.
- Add adversarial integration coverage: tampered/replayed history and ephemeral frames; wrong-room plugin actions; SFU unauthorized produce/consume and cross-room producer IDs; cancelled/restarted source AND target sync (including import password prompt); lock/unlock/wipe/multi-tab cancellation; encrypted backup restore and attachment re-seeding; malicious roster; old PWA refusal. Run two real browsers/devices with relay and SFU after unit/integration checks.
- Target sync also uses global `_transport` in `onProgress` and post-`importDatabase` acknowledgment/cleanup (`sync.svelte.ts:1088-1182`). Cancellation during import/password prompt can continue writes and destroy replacement session state. Include target cancellation in A1 remediation, with an explicit irreversible-import boundary if cancellation cannot safely stop a committed transaction.
- Readiness verdict: **not ready for a general room-security-v2 claim** at this audit snapshot. This is a source audit of a moving implementation, not a certification or evidence that active owners have finished their wiring.
