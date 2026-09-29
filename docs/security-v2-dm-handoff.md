# DM / core transport handoff

Status: active implementation. Exclusive ownership follows security-v2-coordination.md.

Scope: connection-bound first-contact protocol, private DM joins across application
lifecycle, alias-aware receive/profile/call/voice scopes, stale async/key locking
audit, focused tests. Preserve existing local DM IDs and sealed mailbox delivery.

Initial inspection: existing transport secure alias mapping and introduction proof
helpers are present; application adoption remains. Existing modified owned files
are baseline work and will be preserved. No commits, dependency edits or subagents.

Validation planned: Docker node:22-bookworm with awful_fe_node_modules volume,
focused vitest DM/security tests and svelte-check when useful.

Milestones/commands/results and cross-owner contracts will be recorded here.

## Integrated milestone (in progress)

Added bounded mutual connection introduction module and registered it in libp2p.
DM ensure/open/send/receipt/queue/phonebook paths now derive pairwise capabilities;
saved DM restore uses joinStoredRoom. Live DM frames now use sendRoom. Profile,
scope, call and voice predicates recognize local DM aliases. Mailbox retained.

Validation run: `docker run --rm -v /home/flaggzz/repos/awful.chat:/repo -v awful_fe_node_modules:/repo/frontend/node_modules -w /repo/frontend node:22-bookworm npx svelte-check --tsconfig ./tsconfig.app.json`.
Result: no owned-file errors; two webtorrent OPFSChunkStore typing errors (files
owner), and missing sfu bs58 because this invocation omitted the SFU volume.

Still actively working: introduction stream lifecycle tests, fail-closed unbound
DM transport APIs, lock/stale-async checks, application regression checks.
This milestone is not a completed security review or release approval.

## Milestone: transport + first-contact validation

Fail-closed unbound `dm-` join/send/broadcast/SFU/member APIs are integrated.
DM keys and live send/receive/membership are tied to the active identity session;
queue load/send/save and panel/conversation async transitions check session tokens.
Introduction supports mutual proofs, explicit completion acknowledgment, 10-second
deadline, two inbound frames, 24 KB framing cap, 32 concurrent attempts and
deterministic simultaneous-open selection. Proofs use actual Noise device IDs.

Commands (Docker prefix includes both node_modules volumes):

```sh
docker run --rm -v /home/flaggzz/repos/awful.chat:/repo -v awful_fe_node_modules:/repo/frontend/node_modules -v awful_sfu_node_modules:/repo/sfu/node_modules -w /repo/frontend node:22-bookworm npx vitest run src/lib/room-security/dm-introduction-stream.test.ts src/lib/room-security/dm-introduction.test.ts src/lib/room-security/scope.test.ts src/lib/room-security/profile-route.test.ts src/lib/room-security/room-lifecycle.test.ts src/lib/transport/libp2p/transport-room-security.test.ts
# PASS: 6 files, 26 tests
docker run --rm -v /home/flaggzz/repos/awful.chat:/repo -v awful_fe_node_modules:/repo/frontend/node_modules -v awful_sfu_node_modules:/repo/sfu/node_modules -w /repo/frontend node:22-bookworm npx vitest run src/lib/transport/libp2p/room-security.integration.test.ts src/lib/room-security/dm-introduction-stream.test.ts
# PASS: 2 files, 8 tests, including real Noise/Yamux/WebSocket introduction -> pairwise DM delivery
```

### Cross-owner contracts

- Coordinator: identity lock/logout must synchronously start transport disconnect
  (or otherwise explicitly clear secure rooms). DM send/receive gates now reject
  stale identity sessions, but lockIdentity currently only zeros the identity key;
  immediate destruction of ALL retained group/DM channel keys needs a lifecycle
  hook outside this owner's files. Do not claim complete lock/wipe integration yet.
- Files/plugin owners: call `ensureDmRoomForPeer(didOrDevice)` before DM traffic;
  use `sendRoom(peer, localDmId, bytes)` or `sendDmFrame(peer, bytes)` (exported from
  dm.svelte.ts). Never raw send for DM batches. Local DM IDs remain unchanged.
- Saved reopen: `joinStoredRoom(transport, localDmId, record)` derives the secret
  from unlocked identity + record.participantDid and validates the local ID;
  it fails closed if either is missing/mismatched. No roomSecret storage needed.
- Scope consumers must recognize `dm-` aliases as protected; use transport's
  `isSecureRoom` instead of only checking `rd2_`.

Remaining validation: app lifecycle regression tests, final svelte-check, browser
two-device relay/reconnect/mailbox/call tests. No browser validation claimed.
