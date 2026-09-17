# Managed hosting plan

A plan for offering awful.chat as a hosted service: people who trust the
project but do not want a VPS get an instance for a small monthly fee, the
project stays fully open and self-hostable, and the fee pays for keeping
instances up. Nothing here changes the app for self-hosters. Every knob the
service needs is an environment variable a self-hoster can set too.

Status: a plan, not a commitment. Written 2026-09-02.

## The model

- A tenant gets an instance (relay, SFU, frontend) at `<name>.<hosting domain>`,
  or on their own domain.
- Stripe handles billing; a plan is a set of capacity values, nothing more.
- Plans are priced on what the service actually pays for, which is video
  egress and SFU capacity. Text, DMs, files and voice never touch the server.
- Optional add-on: encrypted backup storage for the user's own export, which
  the server can only store, never read.
- Self-hosting stays first class. The docs, the compose file and the Terraform
  the service uses are the same ones a self-hoster gets.

Apache 2.0 allows all of this. Register the project name as a trademark before
the first customer, so hosting under the name is licensed rather than assumed.

## What the operator sees, stated on the pricing page

The README says "trust no one's server, including ours". As the host, the
service is exactly that server, so the page has to say plainly:

- Text, DMs, files and voice: never readable by the host. They are
  end-to-end encrypted between peers and never pass through the SFU.
- Camera and screen share: visible to the host. An SFU decrypts media to route
  it. This is the one honest exception and it stays one.
- Metadata the relay holds: peerIds, room codes registered for rendezvous,
  client IP addresses, sealed mailbox blobs, and telemetry only if the tenant
  turned it on and the user opted in.

What the service does beyond a VPS renter, and why it is worth paying for:

- Every instance publishes the exact build hash it runs; awful-verify checks
  it. "You trust the code, and you can check I am running it."
- Telemetry off by default. No analytics anywhere.
- One-click full export, so a tenant can leave with everything.
- A written abuse and law-enforcement policy, published before launch, that
  states what the host can and cannot produce and how a tenant is suspended.

## Zero-knowledge backups

The backup file is an AES-GCM envelope under a passphrase the host never sees
(see spec.md "Backup Files"), and the at-rest key is derived from the
identity. An automatic upload of that envelope to the service's object storage
is a small feature: the server stores bytes it cannot open. Build this first
among the add-ons. It is the thing a self-hoster cannot easily get, and it
costs nothing in trust.

## Capacity knobs, not plans, in the app

Rule: the app gets capacity knobs, the business gets plans. No tiers, no
license checks, no phone-home in the code. A plan is the environment the
control plane writes for that tenant; a self-hoster sets the same variables
to whatever their machine can carry. Verifiable builds stay intact because
all of it is runtime configuration.

Today there is nothing to turn: camera is 720p at 30 fps, screen share at
15 fps, one encoding, and the SFU forwards what arrives. Three pieces give
graceful degradation under load, in order of value:

1. A hard cap at the SFU. `SFU_MAX_VIDEO_KBPS` applied as the maximum incoming
   bitrate on a producer's transport. The browser's congestion control obeys
   it, a modified client cannot exceed it, unset means today's behaviour.
2. Simulcast. The sender encodes three layers (roughly 180p, 360p, 720p) and
   the SFU picks a layer per viewer with `setPreferredLayers`. Under pressure
   everyone steps down one layer; no call drops or renegotiates. This also
   fixes one slow viewer dragging the sharer down, so self-hosters want it too.
3. A load controller in the SFU's existing sweep: read worker CPU and
   per-transport egress; over a threshold, lower the caps and preferred
   layers, raise them when it clears. For bigger tenants, run several
   mediasoup workers per process with rooms hashed across them.

4K is then a configuration value: the client reads its capture ceiling from
`/config.json` next to the relay and SFU addresses, written by the same
entrypoint from an env var. Price it on egress; a 4K share is roughly three
to five times the bytes of 720p per viewer and needs hardware encoding on the
sender.

## Where to host

Two planes with different economics.

Control plane: anywhere, AWS included. Stripe webhooks, the tenant database,
Terraform state, the signup page. Tiny traffic.

Media plane: not AWS. The SFU and coturn are egress machines, and AWS bills
egress per gigabyte while the VPS providers include terabytes.

| | Screen share, one viewer, one hour | AWS egress | Hetzner / Vultr class |
| --- | --- | --- | --- |
| 30 fps share at about 3 Mbps | about 1.4 GB | about $0.12 | included, then about $0.001 to $0.01 |

Ten viewers for an hour is about a dollar on AWS and effectively free on the
others. That gap is the whole margin of a cheap plan. A CDN cannot front any
of this either: WebRTC and TURN are UDP.

Region matters more than size. Voice is peer to peer, so server latency only
affects video, but put the SFU where the users are. Hetzner is cheapest for
Europe and has no South American region; Vultr and Akamai have Sao Paulo with
bandwidth included.

Hetzner, Vultr, Akamai, DigitalOcean and Scaleway all have full APIs,
Terraform providers, cloud-init, snapshots, object storage and DNS. What they
lack is the managed glue (autoscaling groups, managed databases). The
reconciler below is that glue, and for this app it is small.

## Fleet shape

Neither "one VPS per tenant" nor "a self-healing mesh". A pool, placed by the
hash the app already has.

- Tenant hosts, per region, running stacks: relay, frontend and a small SFU
  each. The compose already runs several stacks on one box with the `STACK`
  prefix and moved port ranges. A 4 vCPU box hosts a couple dozen small
  tenants that are mostly idle, and idle really is idle because voice never
  touches the server.
- coturn is one per host by design (host network), shared by every stack on
  that machine. Credentials are HMAC-minted per instance already; only the
  quotas are per server. Big tenants get their own.
- An SFU pool, per region, a few well-connected boxes. A tenant that outgrows
  its host gets `VITE_SFU_URLS` pointed at the pool. Rooms land on one server
  by rendezvous hashing of the room code, everyone in a room computes the same
  answer with no coordination, adding a server moves only its share, and a
  room never straddles two servers. Prerequisite: multiple mediasoup workers
  per process, otherwise a strong box idles on all but one core.
- The relay stays one per tenant. Go, light, and its peerId is the instance's
  identity. Do not scale it; do not overload the host it lives on.

Self-healing without a placement service, two small changes:

1. The SFU meters itself and refuses NEW rooms when CPU or egress is over
   budget, while still accepting joins to rooms it already hosts. The room
   cap does the second half already.
2. The client walks the ranked list rendezvous hashing gives it: unreachable
   or refused, try the next. Every member gets the same refusal from the same
   server, so they all land on the same next one. No split-brain.

Central placement (a relay-issued "this SFU, this signed token" per room) is
the same feature as the SFU membership proof that has been on the open list
since August. Build it when a customer forces it: per-tenant isolation on
shared servers, or moving a live room.

## The automation

One real component, a reconciler; everything else is glue.

Desired state versus observed state. A small Go service holds a tenant table:
name, plan, region, plugin set, version, status. Stripe webhooks write desired
state. A loop runs every minute, looks at the fleet, and closes the gap:
create a host when no host in the region has room, place the tenant, render
its env from the plan, start the stack, point DNS at it, wait for the health
check, mark it ready. Suspend, resize and delete are the same loop with
different desired state. Terraform owns the fleet-level things that rarely
change (DNS zone, buckets, the control-plane host); per-tenant lifecycle stays
in the reconciler, because Terraform per tenant is slow and its state file
becomes the thing you maintain.

Hosts are cattle. A golden image built with Packer: Docker with the userland
proxy off, Traefik, unattended upgrades, the node exporter. cloud-init on
first boot pulls the host's role and secrets from the reconciler. A dead host
is not repaired; a fresh one is created and its tenants moved. No Dokploy on
the fleet: it is a UI for humans, and nothing here should need one.

Tenants are nearly stateless. Messages, files and history live in browsers.
A tenant's server-side state is the relay identity key, mailbox blobs and any
telemetry. Moving a tenant is a volume copy, a DNS change and a restart.
Rooms survive because clients rejoin; the relay's peerId survives because the
key moved with it.

Updates are waves. CI publishes attested builds. The reconciler bumps tenants
to a tagged release in stages: the service's own instance first, then a tenth
of the fleet, then the rest, with automatic rollback on a failed health
check. Plugins compile into the bundle, so build one image per plugin-set hash
and cache it; most tenants share the default set. Pin plugin sources to a
commit, show the tenant the hash, keep the plugin README's warning.

Health that means something. A tenant is up when its config endpoint answers,
the relay mints a TURN credential, the SFU accepts a websocket, and, nightly,
a synthetic two-peer call connects. The lab harness already drives real
browsers against a deployed instance; pointed at every tenant on a schedule
it is the canary.

Metering closes the loop. Egress and CPU per stack, from the SFU's stats and
the container counters, into the same database. It drives placement (which
host has room), plans (who is over their cap), and the buy-a-box signal.

The three things that actually cause maintenance, designed out early:

- Let's Encrypt limits certificates per domain per week. Many tenants under
  one domain need a wildcard certificate per host through a DNS challenge,
  not one certificate per tenant. Custom tenant domains use HTTP challenges.
- Disks fill. The mailbox and telemetry quotas exist; keep them, back the
  relay volume up nightly to object storage, alert on disk before it matters.
- Kernel updates need reboots. Do them in a window, one host at a time; calls
  drop for a minute and rejoin.

## Abuse and legal exposure

The part nobody budgets for. The host cannot read chat but can see video and
holds the metadata above. Once public, there will be takedown demands and
law-enforcement requests. Before the first paying customer:

- A written policy for what can and cannot be produced, and by what process.
- A way to suspend a tenant (stop the stack, pull DNS).
- A privacy policy that lists exactly the items in "What the operator sees".
- Decide the jurisdiction the control plane and the data live in.

## Effort

Roughly three to four weeks of focused work for a first version: the
reconciler, the golden image, the health probe, the metrics store, the Stripe
webhook. Afterwards the fleet mostly asks for a new box now and then.

Start with one region, one host, stacks per tenant, and let the first heavy
customer decide when the second box is bought.

## Open questions

- Pricing tiers and what the cheap plan includes (viewers per call, egress
  per month, 720p or 1080p ceiling).
- Whether maintainers are paid through a foundation-style split or directly.
- Which region first: the answer depends on where the first users are.
- Whether tenants may bring their own plugin sources at all, or choose from a
  curated list the service has read.
