# lab

Browsers in containers, on networks we control, driving the real app.

Two modes. The lab brings its own relay, SFU, coturn and frontend, or drives
one you already deployed.

```sh
# Mode A - the lab's own stack, disposable and reproducible
./stack.sh
node scenarios/call-audio.mjs
node matrix.mjs
./down.sh

# Mode B - a deployed instance, over the real internet
./up.sh                                     # browsers only
LAB_APP_URL=https://dev.awful.chat node scenarios/call-audio.mjs
LAB_APP_URL=https://dev.awful.chat node matrix.mjs
```

Mode A synthesises the network with `tc netem`, which is what makes a finding
reproducible. Mode B tests the real path: real DNS, real TLS, real TURN, real
routing. Neither replaces the other, and a failure in B that passes in A is
the deployment or the path to it.

## Why this exists

`frontend/e2e` drives real browsers and finds real bugs, but it cannot test the
two things that break in production. Its own note says why:

> NOT `v.links`: headless ICE never completes, so a link object is torn down
> within a second of being built - `scenarios/call-join-speed.mjs`

Every call test there asserts a counter: an offer was sent, a roster holds two
names. A counter cannot tell a working call from a pair who cannot hear each
other, and that pair is exactly what gets reported. Nothing in this repo had
ever asserted that audio arrived.

The lab does. `selfcheck.mjs` is the proof, and it runs against no app at all:
two browsers, a real offer/answer, a real ICE handshake between two network
namespaces, real Opus. If it fails, the lab is broken and every green run it
prints is a lie - so ask it first.

## The one question this answers

Run the same scenario on a good network and a bad one:

| result | reading |
| --- | --- |
| fails everywhere | the code - the network was never the reason |
| fails only when impaired | the network, and the profile names which one |
| passes everywhere | nothing to chase |

`matrix.mjs` runs the profiles and prints that verdict. No per-event heuristic
gets close to it, because the comparison controls for everything else.

## Profiles

`./impair.sh lab-browser-2 loss3` shapes ONE browser's uplink, from inside its
own network namespace, so one peer is on a bad network and the others are not.

| profile | what it is |
| --- | --- |
| `clean` | no shaping |
| `loss3` | 3% loss - "it was breaking up" |
| `loss15` | 15% loss - bad wifi |
| `jitter` | 150ms +/- 60ms - mobile on a good day |
| `slow` | 300ms, 500kbit |
| `reorder` | 20ms with 10% reordering |
| `udp-block` | everything but DNS: ICE must use TURN over TCP or fail |

`netem` shapes egress only. Two peers each shaped on egress is a path degraded
in both directions, which is the condition being tested; an ingress qdisc needs
an ifb device and buys nothing here.

## Things that are load-bearing, and were all found the hard way

- **`--headless`, not `--headless=new`.** The new headless shell ignores
  `--remote-debugging-address` and binds the debug port to loopback inside the
  container, where nothing can reach it (Chromium 124).
- **Browsers reach the app as `http://localhost:5173`**, resolved to the
  frontend container by `--host-resolver-rules`. WebRTC and WebCrypto need a
  secure context: on `http://172.30.0.12:5173`, `crypto.subtle` and
  `navigator.mediaDevices` are simply absent, so the app cannot create an
  identity, let alone open a microphone.
  `--unsafely-treat-insecure-origin-as-secure` did not take effect here.
  Chrome always trusts `localhost`, so the lab uses that - a real secure
  context, with no security switches disabled.
- **Static addresses.** The SFU must announce an address the browsers can
  reach. `docker-compose.dev.yml` announces `127.0.0.1`, which is correct for a
  developer's desktop browser and impossible for a browser in a container: it
  would be handed its own loopback as the media address.
- **Vite 7 answers 403** for a `Host` header outside `server.allowedHosts`, so
  `http://frontend:5173` is refused while the same server answers for
  `localhost` and for its IP.
- **coturn allows this lab's subnet back in.** Production denies relaying to
  RFC1918 ranges and the lab lives inside 172.16/12, so without that one
  `--allowed-peer-ip` every relayed candidate is useless and `udp-block`
  "fails" for a reason that exists only in the lab. Every other private range
  stays denied, as it ships.

## What a scenario asserts

`scenarios/call-audio.mjs` drives the real UI - sign up, create a room, join
it, join the call - and then asserts the only thing that matters: bytes
arrived, both ways, and are still arriving. A count that is merely non-zero
can be a stream that died ten seconds ago.

It reads the connections themselves. A shim installed before any page script
captures every `RTCPeerConnection` the app builds, and `getStats()` is read
across all of them. `window.__awful` cannot be the source: that handle is
`import.meta.env.DEV` only, so it does not exist on a deployed build, which is
where the interesting failures are. The same shim records uncaught throws, and
a scenario fails on any of them - nothing in the app is supposed to reach the
window.

The UI flows are ported from `frontend/e2e/driver.mjs`. Those selectors were
paid for with a day of tests that failed for harness reasons, and the rules
they encode - no fixed sleeps, wipe storage first, retry a click until the
state changes - apply here unchanged.

## What it has found

Ordered by how hard each would have been to find any other way.

- **TURN was dead on the dev deployment.** Three independent breaks, none
  visible from inside the app: the relay advertised a hardcoded port while
  coturn had been moved, the port variable never reached the relay container,
  and the firewall rejected the new port. Every client fetched credentials
  successfully and then gathered no relay candidate at all, so every health
  signal read green. Users on mobile, CGNAT or a restrictive network had no
  voice, and nothing said so.
- **Every Chromium user in a relayed call was told it was direct.**
  `RTCIceCandidatePairStats` carries no candidate type in Chrome; the app read
  one off the pair and got `undefined`. Firefox does expose it inline, which is
  why it survived - the one engine `frontend/e2e` drives was the one where the
  old code was right.
- **`frontend/e2e` could not join a room.** Six references to a placeholder the
  UI had renamed.

Two of those three are in code that had passing tests.
