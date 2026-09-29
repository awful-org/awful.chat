# Bundled PWA cutover validation — 2026-09-27

## Diagnosis/fix handoff — 2026-09-28

**PASS — final real-bundle verification completed.** The prior
120-second timeout was shorter than Chromium's retirement bound for a busy old
worker. This was not another pending-marker or precache-ordering deadlock.

### Concrete evidence

- `transport.svelte.ts` warmed `WORKLET_URL` with bare `fetch()` and never read
  the ~8 MB response body. Fetch resolving only means headers arrived.
- `/tmp/opencode/cutover-lifetime-trace.log` shows every traced old fetch and
  `waitUntil` promise settling, and the new install/skipWaiting settling.
- `/tmp/opencode/pwa-bundled/chrome-trace.json` shows the worklet response stream
  starting, but no corresponding body-reading completion. Chromium considers
  the outgoing worker busy while that stream is still open.
- Chromium's `content/browser/service_worker/service_worker_registration.cc`
  sets `kMaxLameDuckTime = base::Minutes(5)`; `IsReadyToActivate()` uses that bound
  even if the waiting worker has already called skipWaiting.
- A diagnostic-only fetch wrapper that consumed the worklet response let the
  full old/current bundle test pass immediately (`cutover-drained-worklet.log`).
  That wrapper was removed; the final test does not patch either bundle.
- An unchanged old bundle passed the original full scenario with a longer
  timeout (`cutover-long-bound.log`). A rebuilt-current run measured real
  two-tab cutover at **300532 ms** (`cutover-final.log`). That latter run then
  exposed a separate harness race, fixed below.

### Changes

- `frontend/src/lib/transport/transport.svelte.ts`: the minimal additional
  production fix outside the initial worker-only ownership is to consume the
  warmup response with `arrayBuffer()`. Existing unrelated edits were preserved.
  This fixes future updates; it cannot retroactively fix code in installed old
  tabs, whose first cutover can still take approximately five minutes.
- `frontend/src/sw.ts`: retained explicit precache install -> cutover skipWaiting
  and precache activation -> cutover navigation ordering; normalized formatting.
- `frontend/src/lib/room-security/pwa-cutover.test.ts`: added regression proving
  activation finishes even when navigation waits for activation or a tab closes.
- `frontend/scripts/test-bundled-cutover.mjs`: allows 370 seconds **only for the
  real legacy cutover**, logs its elapsed time, asserts failed installs leave no
  cutover marker, asserts zero uncaught page errors, and checks an accepted
  subsequent update activates within the normal 30-second timeout. Trace mode
  observes browser lifecycle without rewriting served workers. Removed all
  temporary diagnostic wrappers/flags.
- Fixed another harness bug: Playwright 1.58's `waitForFunction` treats the
  Promise returned by an async predicate as truthy. Use a registration JSHandle
  and synchronous predicates. The previous "later update waits" assertion could
  return before installation finished; the new assertion waits for `installed`.
  The older fixture-only `test-security-cutover.mjs` still uses an async waiting
  predicate; use this bundled harness as the authoritative update-wait evidence.

### Checks and reproduction

- Final bundled Chromium run: **exit 0**, exact evidence in
  `/tmp/opencode/cutover-verified.log`:
  - Actual app-created encrypted identity and profile (database v6).
  - Cold offline legacy startup and persisted database.
  - Failed real precache install retains offline legacy app, without marker.
  - Both old tabs forced onto current bundle in **300510 ms**, preserving all
    non-telemetry IDB rows and the localStorage sentinel.
  - Subsequent ordinary deployment reaches installed/waiting without forcing
    either tab; explicit acceptance activates in **1016 ms**.
  - Cold offline current startup and unlock with the original password.
  - Zero uncaught page errors.
  - This run used unmodified old/current dist assets, without the diagnostic
    response-draining wrapper or worker instrumentation. The later-deployment
    simulation appends only a comment to the worker to trigger an update.
  - Data coverage is precise: two identity rows and one profile row; room,
    message and attachment stores were empty. This does not claim populated
    history migration or installed/mobile browser coverage.
- Isolated production build: passed; `/tmp/opencode/pwa-bundled/current-build.log`.
- Cutover unit tests: **4 passed**.
- Full Svelte/TypeScript check: **passed, zero errors/warnings**;
  `/tmp/opencode/pwa-bundled/current-check.log`. The frontend-only isolated tree
  initially lacked `sfu/auth.ts`; copying that source and mounting the existing
  `awful_sfu_node_modules` read-only supplied the cross-tree test imports.
- Shared release gate is still **false**; isolated current gate remains **true**.
  No commits, pushes, shared dependency installs, reset or stash.

```sh
docker run --rm -v /tmp/opencode/pwa-bundled:/work -v /tmp/opencode/pwa-bundled/deps:/work/current/frontend/node_modules -w /work/current/frontend node:22-bookworm sh -c 'npm run build > /work/current-build.log 2>&1'
docker run --rm -v /tmp/opencode/pwa-bundled:/work -v /tmp/opencode/pwa-bundled/deps:/work/current/frontend/node_modules -w /work/current/frontend node:22-bookworm npm test -- src/lib/room-security/pwa-cutover.test.ts
docker run --rm -v /tmp/opencode/pwa-bundled:/work -v /tmp/opencode/pwa-bundled/deps:/work/current/frontend/node_modules -v awful_sfu_node_modules:/work/current/sfu/node_modules:ro -w /work/current/frontend node:22-bookworm sh -c 'npm run check > /work/current-check.log 2>&1'
docker run --rm --ipc=host -v /home/flaggzz/repos/awful.chat:/repo -v /tmp/opencode/security-v2-browser:/harness -v /tmp/opencode/pwa-bundled:/builds -e PLAYWRIGHT_MODULE=/harness/node_modules/playwright -e OLD_DIST=/builds/old/frontend/dist -e NEW_DIST=/builds/current/frontend/dist -w /repo/frontend mcr.microsoft.com/playwright:v1.58.2-noble node scripts/test-bundled-cutover.mjs
```

## Earlier coordinator run — 2026-09-28: NOT PASSING (historical)

Follow-up diagnosis: marker was PENDING, not COMPLETE. Changed sw.ts to explicitly
await PrecacheController.install before requesting cutover, and finish precache
activation before navigation. Added direct workbox-routing dependency for its
PrecacheRoute registration. Isolated production build succeeds. Failed installs
now leave no pending marker, but the retry STILL stalls with a waiting worker and
PENDING marker. Therefore ordering change is not a complete fix; investigate
skipWaiting/registration lifecycle and harness automatic update interactions.
No successful retry or bundled-cutover completion claimed.

Refreshed isolated old build to 2cc9dce and current build from working frontend;
enabled release gate only in isolated copy. Both production builds passed.
Ran test-bundled-cutover.mjs with OLD_DIST=/builds/old/frontend/dist and
NEW_DIST=/builds/current/frontend/dist in Chromium Playwright container.
Actual identity creation, cold offline old-app startup and failed-precache
retention passed. Retry then timed out at line 114 waiting for both tabs to
load the new bundle. Both pages retained old bundle; registration had an
activated worker plus an installed waiting worker, and cutover marker cache
existed. Root cause not yet established (worker lifecycle versus harness race).
Do not claim bundled PWA completion. Next: inspect marker contents/worker
transitions immediately after failed installation and before retry; distinguish
automatic registration updates from explicit harness updates.

Historical status: ACTIVE during the earlier run. Work is now complete; handoff
above supersedes the earlier failure/status notes. Owned bundled cutover script,
sw.ts, pwa-cutover*, this handoff, plus the minimal worklet warmup fix described above.
Read coordination and wave-3 PWA handoff; inspected shared git status. Existing
fixture checks do not close bundled application coverage. No shared build,
dependency mutation, release-gate change, commit, push, reset or stash permitted.

Plan: snapshot ae82b28 and current work into isolated /tmp/opencode copies; build
both using isolated dependencies; serve real dist bundles on ephemeral ports and
exercise Chromium multi-tab/offline/update and IndexedDB preservation. Enable
the release gate only in the isolated current copy. Record commands/results here.

Initial handoff writes were interrupted twice by tool transport queue overflow;
no test or build has yet run in this session.

## Milestone 1 — actual bundles built

Both production builds passed. Old is `git archive ae82b28`; current is a tar
snapshot of the working frontend excluding node_modules/dist. Only isolated
current `invitation-release.ts` changed false -> true. Dependencies copied from
read-only `awful_fe_node_modules` to `/tmp/opencode/pwa-bundled/deps`; shared
volume never written. Initial read-only copied-dependency mount failed because
Vite writes `.vite-temp`; writable **isolated copy** fixed it. Commands:

```sh
git archive ae82b28 | tar -x -C /tmp/opencode/pwa-bundled/old
tar --exclude=.git --exclude=node_modules --exclude=.pnpm-store --exclude=dist -cf - frontend | tar -xf - -C /tmp/opencode/pwa-bundled/current
docker run --rm -v awful_fe_node_modules:/source:ro -v /tmp/opencode/pwa-bundled/deps:/target node:22-bookworm cp -a /source/. /target/
# For each TREE=old,current, sequentially:
docker run --rm -v /tmp/opencode/pwa-bundled:/work -v /tmp/opencode/pwa-bundled/deps:/work/$TREE/frontend/node_modules -w /work/$TREE/frontend node:22-bookworm npm run build
```

Logs: `/tmp/opencode/pwa-bundled/{old,current}-build.log`.
Added real-dist harness `frontend/scripts/test-bundled-cutover.mjs`. First run
reached old app identity UI; onboarding dialog intercepted click, harness now
dismisses it through its real Got it button. No worker defect found yet.
