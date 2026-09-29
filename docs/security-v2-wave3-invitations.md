# Wave 3 invitation integration

## Ownership / interruption checkpoint

- Read active three-agent wave in `security-v2-coordination.md`; its scopes supersede older scopes.
- Inspected `git status --short`; extensive existing work is preserved.
- Own invitation/browser integration only; release gate, main.go, manifests and shared configuration belong to coordinator.
- Gate stays false. Browser API coverage will be distinguished from enabled UI coverage.
- Reserved ports: 5181/8180/8181. Isolated artifacts/dependencies: `/tmp/opencode/security-v2-invitations`.

## Checks

- Initial repository status inspection succeeded.
- Coordinator reclaimed scope after the agent's usage-limit error.
- 2026-09-27: production `invite-pairing.ts` and OPAQUE code bundled unchanged
  (production `import.meta.env.DEV=false`) and executed in two independent
  Chromium clients against an actual Go relay over HTTP. Passed secret transfer,
  reuse rejection, wrong-password failure followed by successful retry, host
  cancellation, and five-attempt exhaustion (including correct password rejection
  after exhaustion). 62 relay request/response exchanges checked for plaintext
  room secrets and pairing passwords; none contained either.
- Harness: `frontend/scripts/test-invitation-relay.mjs`. A same-origin fixture
  forwards requests to the actual relay; this does not test cross-origin policy,
  full invitation dialog/QR/custom protocol UI, expiry in real elapsed time, or
  release-enabled ordinary room creation. Those remain open.

## Reproduce

Start a real relay on API port 8081 (or set `PAIRING_RELAY_URL` in the browser
container). The coordinator used the existing source in `golang:1.26-bookworm`,
host networking, and `/tmp/opencode/relay-{gomod,gobuild}` caches. For dependencies
use **pnpm@10.28.0** with `--frozen-lockfile`: unpinned Corepack now selects pnpm 12
and fails on the existing overrides configuration. No lockfile regeneration needed.

```sh
docker run --rm -v /tmp/opencode/security-v2-browser:/harness -w /harness mcr.microsoft.com/playwright:v1.58.2-noble npm install --no-save --package-lock=false playwright@1.58.2 esbuild@0.25.12
docker run --rm --network host --ipc=host -v /home/flaggzz/repos/awful.chat:/repo -v awful_fe_node_modules:/repo/frontend/node_modules -v /tmp/opencode/security-v2-browser:/harness -e PLAYWRIGHT_MODULE=/harness/node_modules/playwright -e ESBUILD_MODULE=/harness/node_modules/esbuild -w /repo/frontend mcr.microsoft.com/playwright:v1.58.2-noble node scripts/test-invitation-relay.mjs
```

## Cross-owner requests / limitations

- UI/QR/custom-protocol and expiry coverage still open; gate remains false.
