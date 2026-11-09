# WebTorrent images stuck at 0%

Investigated 2026-11-08 against upstream and production commit
`3eebb59f886d165914a969dec20b7168595c3b70`.

## Finding

The main and satellite coturn configurations deny their own advertised public
IP as a peer destination. Two clients using the same TURN server receive relay
candidates at that IP, but coturn refuses permission for those candidates to
communicate. This prevents the WebRTC connection underlying WebTorrent from
opening when both ends need that relay. Reloading cannot change the server's
policy. Older cached images can still display without making a connection.

This is a confirmed relay failure that matches the report. The affected room
was not joined and the users' connection stats were not collected, so it does
not establish that every reported stalled image had this exact cause.

## Evidence

- Public `https://awful.chat/.well-known/awful-build.json` identifies the same
  commit as the local checkout.
- Public runtime config selects `https://relay.awful.chat`; `/turn-credentials`
  responds 200 with UDP and TCP TURN URLs on port 3478 and a 7200-second TTL.
- Chromium obtained relay candidates through both URLs. Allocation alone passes.
- A synthetic 600 KiB image completed through the real encrypted WebTorrent
  transport over a direct local WebRTC connection, with identical received bytes.
- The same harness with relay-only WebRTC remained at progress 0 with zero
  torrent peers. Both sides obtained public relay candidates at `31.97.90.100`,
  then ICE moved from checking to disconnected and the connection failed.
- An independent authenticated TURN protocol probe allocated a UDP relay, then
  sent CreatePermission for its advertised public address. The server returned
  response type `0x118` (CreatePermission error), code **403**. A lifetime-zero
  refresh released the diagnostic allocation. No room messages were sent.
- `docker-compose.dokploy.yml` denies `${ANNOUNCED_IP}`;
  `deploy/turn-satellite/docker-compose.yml` denies `${PUBLIC_IP}`.
  [Coturn's documented peer-IP rules](https://github.com/coturn/coturn/wiki/turnserver)
  explain that a matching deny rule refuses the destination unless explicitly allowed.

## Fix and validation

Remove the self-public-IP deny rule from both deployment templates. Retain the
private, CGNAT, loopback, link-local and multicast deny ranges. The public host
must continue to use its firewall to restrict exposed services; the removed rule
blocked all peer ports at that IP, including coturn's legitimate relay range.

Both Compose files pass `docker compose config --no-interpolate --no-consistency
--quiet`. Existing WebTorrent unit tests pass (37 tests). They mock WebRTC and
the torrent client, which is why they do not detect the deployment failure.
The application's `net-probe.ts:probeTurnAllocation()` also checks allocation
only, so a successful probe does not establish that two relay clients can connect.

After applying the configuration, recreate coturn (and
any affected satellite), then repeat a relay-only data transfer between two
clients. It must open a data channel and deliver matching bytes. Allocation-only
checks are insufficient. Production recovery has not yet been verified.
