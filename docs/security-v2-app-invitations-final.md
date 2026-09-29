# Actual bundled-app invitations — 2026-09-28

COMPLETED replacement owner: `ses_f16f08a90ffeMXhyKw2000GZNf`. Previous owner was
interrupted on server restart. Existing test-app-invitations.mjs is being inspected
and preserved. Exclusive writes: that script, this handoff, and necessary
App/AppView/RoomCreateJoin navigation fixes. No other agents known active.

Goal: real release-enabled isolated bundle; UI identity creation/unlock, fragment
import/removal including locked view, persisted room/reload, protocol-handler URL
entry, malformed rejection, captured network secret checks. No app-internal mocks.
Shared gate stays false; no commits/push. Read coordination and prior UI/PWA
harnesses; inspected shared git status.

## Result and fixes

**PASS**, actual current production bundle, Chromium and running Go relay. Final
log `/tmp/opencode/app-invitations-run.log` (exit 0):

- UI-created identities, recovery confirmation and display names; real room
  creation/join, public `rd2_` navigation and encrypted IndexedDB room insertion.
- Incoming full invitation removed from URL before password unlock, then imported.
- Saved public-ID reload, password unlock and original invitation recovered using
  actual Copy invite → Copy link UI. Raw room rows contain no plaintext capability.
- Unlocked and locked same-document fragment changes both import correctly;
  locked entry removes the fragment while retaining the pending invitation.
- Actual manifest `web+awfl` handler URL entry and unlock/import pass. This is
  **URL navigation, not native OS protocol handoff**.
- Malformed `r2_malformed` removes fragment and displays `Invalid v2 invitation`,
  without creating another room or mounting chat.
- **1,899 captured HTTP/WS observations** contain no plaintext invitation
  capability; zero uncaught page errors. Captures include HTTP URLs/headers/request
  bodies, proxied API response bodies, WebSocket URLs and sent/received frames.
  This does not claim packet-level capture of WebRTC traffic or all possible
  third-party response bodies.

Production change is only the additional AppView navigation fix:
`consumeRoomLocation` scrubs incoming non-public-ID room inputs immediately on
AppView construction/navigation, retaining the input in memory until unlock.
Pending room processing now runs on subsequent unlocks as well as first bootstrap.
Hash navigation is handled with a duplicate-event guard: Chromium can emit
popstate then hashchange; after popstate scrubs the URL, the older hashchange must
not clear the locked pending invitation. The meaningful browser regression found
and verified this edge case. No additional App.svelte/RoomCreateJoin edits needed.

Initial actual-bundle run failed because the secret remained visible on the
locked screen. Intermediate harness corrections: the Copy invite button opens a
menu, Copy link completes asynchronously, and same-path fragment goto does not
reload/lock an unlocked identity. None of those were app-internal mocks.

## Build and checks

Refreshed isolated frontend source from shared working tree (including existing
uncommitted work), enabled only isolated invitation-release.ts, then rebuilt.
`npm run build` and full `npm run check` passed (0 errors, 0 warnings).
Logs: `/tmp/opencode/pwa-bundled/app-invitations-{build,check}.log`.
Shared gate re-read after verification: **false**. No commits or pushes.

```sh
tar --exclude=node_modules --exclude=.pnpm-store --exclude=dist -cf - frontend | tar -xf - -C /tmp/opencode/pwa-bundled/current
# In the isolated copy only, change ROOM_SECURITY_V2_RELEASED false to true.
docker run --rm -v /tmp/opencode/pwa-bundled:/work -v /tmp/opencode/pwa-bundled/deps:/work/current/frontend/node_modules -v awful_sfu_node_modules:/work/current/sfu/node_modules:ro -w /work/current/frontend node:22-bookworm sh -c 'npm run build > /work/app-invitations-build.log 2>&1 && npm run check > /work/app-invitations-check.log 2>&1'
docker run --rm --network host --ipc=host -v /home/flaggzz/repos/awful.chat:/repo -v /tmp/opencode:/work -e PLAYWRIGHT_MODULE=/work/security-v2-browser/node_modules/playwright -e APP_DIST=/work/pwa-bundled/current/frontend/dist -e RELAY_MULTIADDR=/ip4/127.0.0.1/tcp/8080/ws/p2p/12D3KooWD4RpAZe6mKioPSbgWPUos2tLHCx4w6yig27EamHsE3Gu -e RELAY_TLS_KEY=/work/app-invitations-key.pem -e RELAY_TLS_CERT=/work/app-invitations-cert.pem -w /repo/frontend mcr.microsoft.com/playwright:v1.58.2-noble node scripts/test-app-invitations.mjs > /tmp/opencode/app-invitations-run.log 2>&1
```

Reused the previous owner's running `security-v2-app-invitations-relay` container
on host ports 8080/8081; it remains running. Actual command/config was inspected:
`go run .`, `/src` working directory, relay source mounted read-only, existing
Go module/build caches. If absent, reproduce with:

```sh
docker run -d --name security-v2-app-invitations-relay --network host -v /home/flaggzz/repos/awful.chat/relay:/src:ro -v /tmp/opencode/relay-gomod:/go/pkg/mod -v /tmp/opencode/relay-gobuild:/root/.cache/go-build -w /src golang:1.26-bookworm go run .
docker logs security-v2-app-invitations-relay
openssl req -x509 -newkey rsa:2048 -nodes -keyout /tmp/opencode/app-invitations-key.pem -out /tmp/opencode/app-invitations-cert.pem -days 2 -subj /CN=relay.example.test
```

Use the PeerID printed by a newly started relay in RELAY_MULTIADDR. The harness
terminates test TLS on an ephemeral port and pipes untouched libp2p/Noise bytes
to the real relay's port 8080. Chromium maps relay.example.test to loopback and
accepts that test certificate; this supplies the secure DNS websocket address
required by production connection gating without modifying the app's gater.
Runtime config is real deployment config served by the harness, not a module
mock. Server/TLS ephemeral ports and all browser contexts close after the test.

## Boundaries / handoff

No remaining blocker in this assigned browser scope. This test does not replace
the previous component/OPAQUE pairing/QR lifecycle suite and does not claim mobile,
native protocol registration, or whole-feature release readiness. Coordinator
still owns the global release decision. Exact owned shared files changed:
`frontend/scripts/test-app-invitations.mjs`, AppView.svelte, and this handoff.
