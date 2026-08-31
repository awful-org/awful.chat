# Adding servers to an instance

The main instance (`docker-compose.dokploy.yml` at the repo root) runs
everything on one box. Two of those pieces can be multiplied and put closer to
your users: **TURN** and the **SFU**.

|  | What it buys | What it really costs |
| --- | --- | --- |
| Extra TURN | Faster connects and lower relayed latency for peers near it. | The shared secret, visible IP and connection timing for every peer connection of every client worldwide, and open relay abuse risk (size `--total-quota` and `--user-quota` accordingly). A server that stops answering costs an ICE timeout instead of failing fast. |
| Extra SFU | Rooms spread across servers, each room served by the one it hashes to. | A frontend rebuild, and rooms split until every client has the new bundle. Its operator can watch the video. |

## Who you are trusting

Adding a server hands somebody a role in the instance. The two roles are not
remotely equal, and for this app the difference matters more than the setup.

**A TURN operator sees metadata, not content.** Relayed media stays encrypted
end to end (DTLS-SRTP between the peers), so they cannot watch or listen. They
see the IP address and connection timing of every user on every peer connection,
not only those that relay, because clients offer all TURN URLs to ICE on every
connection regardless of whether relaying is eventually used. They also see the
endpoint addresses for any traffic they relay.

Their server is also an **open relay**, and that is your doing rather than
theirs: the instance's own `/turn-credentials` endpoint hands 2 hour reusable
credentials to anyone who asks (a request with no Origin header at all is
deliberately allowed, so a plain `curl` gets one), and those credentials work
on every TURN server in `TURN_URLS`. Anyone who wants one can relay traffic to
any host on the internet through the volunteer's machine, so DDoS reflection,
spam and scanning are attributed to their IP address, not yours. Browsers never
use TCP relaying, so `--no-tcp-relay` is set and only UDP is exposed, and
`--total-quota` and `--user-quota` bound how much of it one party can use at
once - size them for a machine you do not own. None of this is specific to a
satellite: the main instance has exactly the same shape.

They also hold `TURN_SECRET`, which is the entire authentication system: with
it they can mint valid credentials for **every** TURN server on the instance,
including yours. There is one secret, so handing it over is handing over the
right to use all of them.

**An SFU operator sees the video.** An SFU decrypts media to route it - the
honest exception the [main README](../README.md) names - and there is no
end-to-end encryption for media anywhere in the client. So whoever runs one
can see camera and screen share for every room placed on their server. Rooms
are placed by hashing the room code, so neither you nor the participants
choose which conversations land there, and nothing in the UI says which server
is in use. The room codes themselves also pass through their logs.

The SFU is additionally **open to the internet with no authentication**:
anyone who knows a room code can join one directly. That is true of the main
instance too, but each satellite is another door.

Text and DMs never touch either kind of server. Voice and file transfer are
peer to peer and normally do not either, but when a direct path cannot be
formed - mobile carriers and strict NATs, which is the whole reason TURN
exists - they are relayed through TURN, encrypted, with the operator seeing the
endpoints and volumes but not the content.

So: a TURN server is a reasonable thing to accept from someone you trust to
run a machine. An SFU is not. Only add an SFU you would be comfortable letting
watch your calls.

## Add a TURN server

Best value per unit of effort, and the one a friend can host: a stock
container and a secret, with no checkout of this repository.

1. On the new server, take [turn-satellite/](turn-satellite/) (two files):

   ```sh
   cp .env.example .env
   # PUBLIC_IP        this server's public address
   # PUBLIC_HOSTNAME  a DNS name pointing at it (DNS-only, not behind a CDN)
   # TURN_SECRET      the SAME value as the main instance
   docker compose up -d
   ```

   All three are required and compose refuses to start without them. The two
   machines also need clocks agreeing to within the credential's 2 hour
   lifetime, since the username IS an expiry timestamp.

2. Open `3478/udp`, `3478/tcp` and the relay range (`49152-50151/udp` by
   default). Add `5349/tcp` if you enable TLS.

3. On the main instance, list **every** TURN server in `TURN_URLS`, including
   the instance's own, and redeploy the relay:

   ```sh
   TURN_URLS=turn:relay.example.com:3478?transport=udp,turn:relay.example.com:3478?transport=tcp,turn:turn-us.example.com:3478?transport=udp,turn:turn-us.example.com:3478?transport=tcp
   ```

   `TURN_URLS` **replaces** the built-in default rather than adding to it, so
   leaving your own server out silently sends all relayed media through the
   satellite. Only the relay restarts; no frontend rebuild, because the list
   is served at runtime by `/turn-credentials`.

   With TLS enabled, append the `turns:` URL too - a listener nobody is told
   about serves nobody:

   ```
   turns:turn-us.example.com:5349?transport=tcp
   ```

The secret is all that is shared; the two machines never talk to each other.
Every URL in the list costs an allocation attempt on every peer connection, so
remove entries that stop answering rather than leaving them to time out.

**The hostname must be DNS-only.** TURN is UDP and raw TCP, which CDN proxies
do not forward, so a proxied hostname is a TURN server nobody can reach.

## Add an SFU

1. Set `{"userland-proxy": false}` in `/etc/docker/daemon.json` and restart
   docker. The media range is published as individual port mappings, and
   docker's default userland proxy spawns a process per port per protocol -
   measured at 2000 processes and 8.4 GB of RAM for the default range, which
   will OOM a small VPS. With the flag off it is pure iptables DNAT.

2. Clone this repository and use [sfu-satellite/](sfu-satellite/):

   ```sh
   cd deploy/sfu-satellite
   cp .env.example .env
   # PUBLIC_IP     this server's public address
   # SFU_HOSTNAME  a DNS name pointing at it
   docker compose up -d
   ```

   Caddy gets its own certificate, so it needs `80` and `443` open, plus the
   media range (`61000-61499` udp and tcp by default).

3. On the main instance, list every SFU and **restart the frontend**:

   ```sh
   VITE_SFU_URLS=wss://awful.example.com/sfu,wss://sfu-us.example.com/sfu
   ```

   ```sh
   docker compose up -d frontend
   ```

   This used to be compiled into the bundle and need a rebuild. It is served
   as `/config.json` now, written from the container's environment at start,
   so a restart is enough - and the variable has to reach the container as
   environment, not as a build arg.

### Changing the list splits rooms until clients reload

This is the one operational trap. Placement is computed from the list the
client has, and a client reads that list once, at startup. So a session open
across the change places rooms using the old list while a freshly loaded one
uses the new list, and two people in the same room can land on different SFUs.
Chat and presence are unaffected (they go through the relay), so it shows up
as "video is broken for some people", not as a deploy problem.

A plain page reload is enough to pick up the new list - it no longer waits on
a service worker update prompt, because nothing about the list is in the
bundle. Still, change it when the instance is quiet, and leave a removed SFU
running until you are confident every client has reloaded.

### What this does and does not do

It places rooms; it does not balance load. A room lives entirely on one SFU
because there is no router cascading between instances, so the server a room
lands on is the server all its participants use, and a room is only as fast as
that one server. The useful arrangement is one SFU near each cluster of users,
not several in one city.

Placement is a hash of the room code, so every participant with the same list
resolves the same server offline, with no coordinator and no extra round trip.
It is rendezvous hashing, so adding a server moves only its own share of rooms
rather than reshuffling everything, and a call already in progress is never
moved - the URL is resolved once, at join.

An instance with `VITE_SFU_URLS` unset keeps using `/sfu` on its own origin
exactly as before.

### Capacity

The media port range is the ceiling, not `SFU_MAX_ROOMS` (which counts rooms).
mediasoup keeps separate UDP and TCP port pools, so an N-port range allows N
transports, and a participant in a call holds two of them - send and recv.
The default 500-port range is therefore about **250 concurrent participants**.
Widen the range and raise `SFU_MAX_ROOMS` together, or neither.

Keep the range above 60999. Docker binds every port in it at container start
and a single port already in use aborts the whole container, so a range inside
Linux's ephemeral window (32768-60999) makes the SFU fail to start at random,
typically after a reboot.

## What cannot be multiplied yet

The **relay** is single. It holds the rendezvous registry (who is in which
room) and the offline mailbox in its own storage, so two relays would be two
disjoint worlds: peers registered on one would never discover peers on the
other, and mail left with one would never reach a client polling the other.
Federating it needs cross-relay peer exchange and a home relay per mailbox,
which is a design change rather than a config one.

**Do not set `deploy.replicas` on the relay service.** Nothing in the
compose or the relay's own code stops it, but the registry and mailbox
above live in this ONE process's memory and on its ONE volume. A second
replica would load the same `relay.key` from that shared volume and
announce the same PeerID, while holding a completely separate, empty
registry - so half of every room's members would land on one replica and
half on the other, and each half would never see the other half in its
`PEERS` reply. The relay logs a warning naming this constraint at boot,
next to its PeerID, but there is no code check that refuses a second
replica outright.

**Set `TRUSTED_PROXY_CIDRS` before you go live.** The relay's API port is
reachable by every container on `dokploy-network`, not only Traefik, and the
default trusted range (see `.env.example`) is the whole private address
space - so on this compose shape, ANY container can forge `X-Forwarded-For`
and pick its own bucket for every per-IP rate limit the relay has
(`/turn-credentials`, `/invite`, `/mailbox`, `/plugin-proxy`). Narrow it to
Traefik's own address on your `dokploy-network`, as a single `/32`.
