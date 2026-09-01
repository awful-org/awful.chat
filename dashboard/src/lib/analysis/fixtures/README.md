# Captured fixtures

Real data, produced by the real code. The rule engine must be validated
against what the app actually emits: a hand-built fixture only proves the
engine agrees with itself.

Every file here came from one local capture session on 2026-09-01.

| File | Vantage | How |
| --- | --- | --- |
| `client-a-stapled.json` | client + relay | Peer A's bundle, exported and uploaded from **Settings > Diagnostics**, with the relay's own vantage stapled at ingest. Read back through `GET /telemetry/get`. |
| `client-b-stapled.json` | client + relay | The same, from Peer B, a separate browser profile in the same room. |
| `sfu-snapshot.json` | sfu | A real `ms:diag` reply from a real mediasoup router, two peers in one room, one producing audio. Captured by `sfu/scripts/capture-sfu-vantage.ts`. |
| `sfu-telemetry.log` | sfu | The `[sfu-telemetry]` sweep line the same SFU printed for the same room. |
| `relay.log` | relay | The relay's own stdout for the same session, including the new `reason=` on every stream close. |

## The one substitution

`relay.log` had its room code replaced by the literal `ROOMCODEFIXTURE`.

The SFU and the relay log full peer ids and room codes in clear - that is the
established precedent for an operator's own container log, and `logs.ts` is
the one place a room code can enter the dashboard. A committed fixture is not
an operator's private log, so the code does not belong in the repository. The
substitution changes nothing the parsers read: `parseRelayLog` matches the
line shape and captures whatever the bracket holds.

Peer id suffixes (`TBsh4Aqx`, `SH4gDmtC`) are REAL and must stay real. They
are what `resolveSuffix` resolves against the full ids in the two bundles, and
a fake suffix would make that test prove nothing.

`sfu-telemetry.log` keeps its room name (`fixturecapture01`): the capture
script chose it, so it never named a real room.

## What the capture did

1. A relay with `TELEMETRY_ENABLED=1` and `TELEMETRY_ADMIN_TOKEN=dev`, an SFU
   with `SFU_TELEMETRY=1`, and `pnpm dev` for the app.
2. Two browser profiles, one identity each, both in one room, one real
   message sent between them.
3. `window.__faults.set({ blockWebrtcDial: true })` in Peer A, so a direct
   upgrade cannot complete and the pair stays on a relay circuit.
4. The relay was restarted mid-session. That was not planned, and it is the
   most useful part of the capture: it produced real `relay.disconnect`,
   `relay.reconnect.schedule`, `rv.close` and re-registration events.
5. Both peers uploaded from the Diagnostics pane. Both bundles were read back
   through the operator endpoint.

## Regenerating

```sh
# relay, from a checkout, with a writable data dir
TELEMETRY_ENABLED=1 TELEMETRY_ADMIN_TOKEN=dev TELEMETRY_DIR=/tmp/awful-telemetry go run ./relay

# sfu
cd sfu && SFU_TELEMETRY=1 npx tsx index.ts

# app, pointed at the relay's printed multiaddr
cd frontend && VITE_API_URL=http://localhost:8081 \
  VITE_RELAY_MULTIADDR=/ip4/127.0.0.1/tcp/8080/ws/p2p/<id> pnpm dev

# the sfu vantage
cd sfu && npx tsx scripts/capture-sfu-vantage.ts
```

Then follow the five steps above and copy the two bundles out through
`GET /telemetry/list` and `GET /telemetry/get`.

Note: the relay hardcodes `/app/data` for its key. A local run needs that path
to exist, or a dev-only override.
