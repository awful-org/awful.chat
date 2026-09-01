# awful.chat diagnostics console

An operator console. It reads diagnostic bundles and container logs from a
broken awful.chat session, reconstructs the topology over time, runs a
deterministic rule engine, and builds a prompt pack for a model.

It is a separate application from the chat app. It ships no service worker, no
runtime config and no telemetry of its own. It is not deployed.

## Standing warning

**Never expose this console on the public internet.**

It holds a relay admin token and it renders full peer ids. An SFU log also
carries room codes in clear, and a room code is a room's only membership
secret. Run the console on your own machine. Point it at a relay over HTTPS.
Close the tab when you finish.

The console's own output is safe to share. A bundle carries opaque room refs and
no `did:key:`, and the prompt pack is built from the capture, never from the raw
log text.

## Run it

```sh
cd dashboard
pnpm install
pnpm dev            # http://localhost:5174
```

For a static copy:

```sh
pnpm build          # writes dist/
open dist/index.html
```

Checks:

```sh
pnpm check          # svelte-check plus tsc
pnpm test           # vitest, the analysis modules
```

## Load a capture

Drop files on the Sources view, or use the file picker. The console accepts two
kinds of file and reports what it did with every one of them.

**A client bundle.** The JSON that the chat app's Settings → Diagnostics pane
exports, named `awful-diag-<bundleId>.json`. A bundle that a peer uploaded also
carries the relay's stapled vantage, which is a second point of view on the same
session.

**A container log.** Three shapes are known:

| file | parser | source |
|---|---|---|
| `docker logs -t <sfu>` | sfu container log | `[sfu-telemetry]` json plus the free-form `[sfu]` and `[router]` lines |
| `docker logs -t <relay>` | relay container log | the `[rv]`, `[relay]`, `[http]` and `[peer]` lines |
| pasted browser output | browser console | the house `[tag] message` shape |

The console picks a parser from the tags a file carries. The choice is a guess,
so the Sources view shows it as a select and reports the unmatched line count.
Change the select if the guess is wrong. An unrecognised line is never dropped:
it survives as a `raw` event, and the Logs view shows it beside the raw text.

### Docker timestamps

**Use `-t`.** Docker writes a timestamp only when you ask for one:

```sh
docker logs -t awful-relay > relay.log
docker logs -t awful-sfu   > sfu.log
```

Without `-t` a log line has no absolute time. The parser then anchors every line
relative to the first line it matched, and it adds a warning to the file. Such a
log still shows an order of events, but it cannot be aligned with a client
bundle, so every cross-vantage finding from it is unreliable.

## Read a relay

A relay exposes two read routes when the operator sets
`TELEMETRY_ADMIN_TOKEN`. Give the host and the token to the relay form on the
Sources view, then press **List bundles** and load the ones you want.

The token stays in memory. It is never written to `localStorage`, never put in a
URL and never logged. A reload loses it. That cost is deliberate.

A 404 from either route means the operator did not set the token, so the console
says exactly that. The relay answers 404 rather than 403 on purpose: it must not
advertise a console that does not exist.

## The views

| view | question it answers |
|---|---|
| Sources | What is loaded, and what happened to each file? |
| Sessions | Which captures exist, and which one do I want? |
| Findings | What is broken, what does it mean, and what do I change? |
| Timeline | Every vantage's events in one absolute-time stream, in lanes. |
| Topology | What did the graph look like at one instant? |
| Matrix | Do two peers disagree about their link? |
| Peers | Everything one peer did, from every vantage. |
| Logs | Did the parser read this log correctly? |
| AI | The prompt pack, and an optional endpoint to send it to. |

Two conventions carry most of the meaning.

**A link is directed.** A link is what one peer *believed* about another. In
Topology a two-way link draws two solid arcs, and a one-way link draws one
dashed arc with a hollow arrowhead plus an ✕ stub from the silent peer. In
Matrix every cell is one square split on its anti-diagonal: the upper-left half
is what the row peer believed, the lower-right half is what the column peer
believed. Agreement makes a flat square. Disagreement makes a hard seam.

**Ignorance is not a failure.** A peer that uploaded no bundle cannot report
anything. Its half of a Matrix cell is faint and marked `?`, and Topology draws
no ✕ for it.

## Keys

In the Timeline view:

| key | action |
|---|---|
| `j` | next event |
| `k` | previous event |
| `f` | next finding evidence |

The cursor drives the scrubber, and the scrubber drives the Topology and Matrix
views. So `j` walks the graph forward one event at a time.

## Layout

```txt
src/lib/schema.ts            a mirror of frontend/src/lib/telemetry/schema.ts
src/lib/analysis/merge.ts    vantages -> captures, clock skew corrected
src/lib/analysis/topology.ts the graph at one instant
src/lib/analysis/rules.ts    the rule table: meaning, remedy, ai hint
src/lib/analysis/findings.ts the engine
src/lib/analysis/logs.ts     the four log parsers
src/lib/analysis/prompt.ts   the prompt pack
src/lib/sources.svelte.ts    the only reactive state in the app
src/lib/views/*.svelte       nine views, render only
```

Every module under `analysis/` is pure and has a `.test.ts` sibling. Every rune
lives in `sources.svelte.ts`. A `.svelte` file renders and nothing else. That
split is what makes the engine testable without a browser.

`schema.ts` is a byte-for-byte mirror of the frontend copy. A change must land
in both files, and in `sfu/telemetry.ts` for the SFU snapshot types.

## Fixtures

`src/lib/analysis/fixtures/` holds a real capture: two client bundles with the
relay's vantage stapled, a real SFU snapshot, and the relay's and the SFU's own
logs. `e2e.test.ts` runs the whole pipeline over it.

Those fixtures are what keep the engine honest. Every other test builds its own
input, so it can only prove the engine agrees with itself. Read
`src/lib/analysis/fixtures/README.md` for how the capture was made, what the one
substitution in `relay.log` is, and how to regenerate it.
