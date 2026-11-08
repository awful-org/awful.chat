# Images fail in Firefox private windows

Reported during localhost testing on 2026-11-08, using Zen and an anonymous
window as a second chat client. Separate from the TURN self-IP denial.

## Reproduction and cause

Firefox with `browser.privatebrowsing.autostart=true` exposes
`navigator.storage.getDirectory`, but calling it raises `SecurityError`:
`Security error when calling GetDirectory`. A normal Firefox session and
Chromium both passed the same disposable-file read/write probe.

The encrypted transfer pipeline assumed OPFS was usable for ciphertext staging,
download pieces and the ciphertext store. API presence alone therefore passed,
while the actual file operation failed. Downloaded-file publication could not
complete and the preview remained empty. Small protected files also use this
pipeline; their size does not exempt them from storage requirements.

[Mozilla documents this private-mode SecurityError](https://developer.mozilla.org/en-US/docs/Web/API/StorageManager/getDirectory).

## Change

`file-storage.ts:fileStorageRoot()` prefers native OPFS and falls back to a
page-local, bounded ciphertext filesystem only when the API is absent or throws
SecurityError/NotSupportedError. Genuine disk/quota errors still propagate.
The fallback implements only the handle operations used by transfer staging,
piece stores and lease cleanup. It holds at most 64 MiB in aggregate, counting
committed files and writes in progress, and frees quota on abort/removal.
Large transfers can exceed this budget because ciphertext copies and pieces
all count; the error recommends a regular browser window.

`OPFSLease` and `ciphertext-store.ts` use this common root. Encryption and
per-chunk authentication are unchanged, and no plaintext is stored in this
filesystem. Temporary files vanish with their page. Existing small-file
persistence still uses sealed IndexedDB attachment rows.

Torrent startup and publication failures retain their actual error messages;
`MsgRender.svelte` displays failed-transfer errors instead of only another
Download button.

## Validation

- Actual Firefox private mode: native OPFS probe still raises SecurityError.
- Two disposable private Firefox pages, real WebTorrent/SimplePeer, synthetic
  signaling bridge: encrypted 2,250-byte PNG transfers automatically and decodes
  to 192 px, with no click to fetch it.
- Full local chat UI in Firefox private mode: disposable identity and new room,
  upload/send PNG, own preview loads at 192 px with no download click.
- Regression coverage includes ciphertext-only seeding/restoration with denied
  OPFS, atomic temporary writes, shared quota, abort/cleanup, native OPFS
  preference and surfacing genuine storage/startup failures.

Tests used disposable identities and isolated local rooms. No existing user
profile or production room was accessed. Existing clients need to reload the
updated modules before retrying a failed transfer. No production deployment
was performed.

Final checks: `pnpm check` passes with zero errors/warnings; 104 file/preview
tests pass; `pnpm build` succeeds with all local plugins included.
