# PWA cutover verification — 2026-09-27

The assigned wave-3 agent stopped at its usage limit before recording results.
Coordinator reclaimed its scope. No active agent is assumed.

## Verified and fixed

Real Chromium reproduced an activation deadlock: awaiting `WindowClient.navigate`
inside `activate.waitUntil` keeps activation open, while navigation waits for
activation. Production code now calls `navigateSecurityCutoverWindows`, which
starts navigations without waiting for their completion.

`frontend/scripts/test-security-cutover.mjs` transpiles the production helper and
uses it in real service workers with small controlled page/cache fixtures. Passed:

- Offline startup of a previously installed legacy page.
- Failed update precache installation followed by a successful retry.
- Two legacy tabs automatically navigate to the new worker's page.
- Existing localStorage data remains intact.
- A later ordinary update waits; neither tab is forcibly reloaded.
- Fresh v2 installation does not reload; its later ordinary update also waits.

This is **not** complete bundled-app UI, installed/mobile PWA, indexed database
history preservation, or release-enabled end-to-end coverage. Those remain open.
The release gate remains false.

## Reproduce

Install browser-only dependencies outside the repo (repeat after temporary storage
is lost; this restart cleared `/tmp/opencode`):

```sh
docker run --rm -v /tmp/opencode/security-v2-browser:/harness -w /harness mcr.microsoft.com/playwright:v1.58.2-noble npm install --no-save --package-lock=false playwright@1.58.2
docker run --rm --ipc=host -v /home/flaggzz/repos/awful.chat:/repo -v awful_fe_node_modules:/repo/frontend/node_modules -v /tmp/opencode/security-v2-browser:/harness -e PLAYWRIGHT_MODULE=/harness/node_modules/playwright -w /repo/frontend mcr.microsoft.com/playwright:v1.58.2-noble node scripts/test-security-cutover.mjs
```

Browser test passed again after moving navigation logic into the production
helper. Three existing cutover unit tests passed. Full type check initially
failed because the Docker volume was missing the locked OPAQUE dependency;
frozen-lockfile pnpm install restored it and the next full type check passed
with zero errors/warnings. No dependencies were added to the repository.
