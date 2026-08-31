# Published build records

One file per commit on `main`, written by `.github/workflows/publish-build.yml`.

Each record is the sha256 of every file the frontend image serves for that
commit, taken by running the verifier against the real image rather than
against a directory. It exists so that checking an instance needs no
toolchain: fetch the record for the commit an instance declares, compare the
digest, done.

A record describes a commit **and** a plugin set. Plugins compile into the
app, so an instance running a different set is a different bundle and is
supposed not to match.

These records are output, not source. The branch has no history in common
with `main` on purpose - otherwise every commit to `main` would produce a
second commit on `main`.

Verify one against GitHub's build provenance:

```sh
gh attestation verify <commit>.json --repo awful-org/awful.chat
```
