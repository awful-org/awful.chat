# Invitation UI final verification — 2026-09-27

Owner: invitation UI subagent. Scope restricted to InvitationDialog, RoomCreateJoin,
invite-pairing*, new scripts/test-invitation-ui.mjs, and this handoff. No commits,
dependency changes, or shared gate edits. Read coordination and invitation handoffs;
inspected dirty tree and preserved existing work.

## In progress

Actual Svelte component/browser harness with real relay pairing. Enabled gate will
exist only in isolated test copy under /tmp/opencode. UI completion is not inferred
from the previously passing production-module relay harness. Exact commands and
coverage boundaries will be recorded here at each milestone.

## Milestone 1 — actual components pass

`frontend/scripts/test-invitation-ui.mjs` uses isolated copied source, Vite's
production Svelte compiler, real bits-ui dialog/button/input, production QR encoder,
production invite parser and OPAQUE client. Only copied gate is enabled. Profile,
storage, transport status, and avatar-dialog shell are fixtures; `onJoin` is
captured, not dispatched to AppView. Share API is simulated; clipboard is real
Chromium clipboard. QR rendered pixels match separately generated full-link QR
pixels (PNG bytes differ between browser canvas and Node encoders).

Passing run: create/name/copy/QR, native-share payload and abort/failure fallback,
invalid/legacy/public-ID rejection, paste, full/custom-protocol link parsing,
RoomCreateJoin and InvitationDialog each pairing UI-to-UI through real Go relay,
reuse rejection, consumed-code removal, dialog-close relay cancellation and clean
reopen. 29 relay exchanges checked for plaintext capability/password; no browser
exceptions, shared gate still false. No AppView URL-cleanup or OS protocol claims.

Commands (relay published API dynamically as 32768 in this run):

```sh
docker run --rm --name security-v2-invitation-relay-final -p 127.0.0.1::8081 -v /home/flaggzz/repos/awful.chat/relay:/src:ro -v /tmp/opencode/relay-gomod:/go/pkg/mod -v /tmp/opencode/relay-gobuild:/root/.cache/go-build -w /src golang:1.26-bookworm go run .
docker port security-v2-invitation-relay-final 8081
docker run --rm --network host --ipc=host -v /home/flaggzz/repos/awful.chat:/repo -v awful_fe_node_modules:/repo/frontend/node_modules -v /tmp/opencode/security-v2-browser:/harness -e PLAYWRIGHT_MODULE=/harness/node_modules/playwright -e PAIRING_RELAY_URL=http://127.0.0.1:32768 -w /repo/frontend mcr.microsoft.com/playwright:v1.58.2-noble node scripts/test-invitation-ui.mjs
```

Initial harness-only failures were corrected: missing unrelated media fixture
export, comparing compressed PNG bytes instead of pixels, waiting for async paste.
