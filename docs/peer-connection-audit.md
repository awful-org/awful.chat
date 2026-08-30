# Peer connection status audit

Audit of the peer-connection status apparatus across four layers: P2P voice
(`libp2p/voice.ts`), the libp2p transport (`libp2p/transport.ts`), the SFU
path (`mediasoup.ts` and `sfu/index.ts`), and the relay (`relay/*.go`). The
audit ran against commit `c9b92cb`. The repair landed on top of it. This
document is the record: what was wrong, what changed, and what is still
open.

Method note: every citation below is either a pre-fix line number quoted
from one of the four audits (against `c9b92cb`), or a post-fix line number
checked directly against the current worktree while writing this document.
Citations without a line number point at a file whose change is described
in a fix report but was not independently re-read line-by-line for this
document.

## Why this exists

Two symptoms drove the audit. First, a peer that connects and carries
nothing: the tile reads "connected", the other person's icon looks normal,
and no audio, video, or screen share ever arrives. Second, a peer that goes
silent mid-call while every other peer in the same call stays fine: someone
who was audible or visible a minute ago stops, with no error and no change
in their tile. Both symptoms were reported without a stack trace and
without a reliable repro, because nothing in the code told the difference
between "this link is fine" and "this link reports fine".

## The single root cause

Four independent audits, four independent codebases (TypeScript client,
TypeScript SFU, Go relay), one shared defect. Every repair path in every
layer keyed on a proxy for liveness — `RTCPeerConnection.connectionState`,
libp2p's `connectedPeers` set membership, a resolved `produce()`/`consume()`
call, a signalling frame — and none of them checked whether media or frames
were actually flowing. A link can hold `connectionState === "connected"`
forever while the audio it carries has stopped, and every audit found at
least one and up to seven concrete ways that happens.

The clearest statement of this was already in the code before any of these
fixes landed. `frontend/src/lib/transport/libp2p/voice.ts` carried this
comment on its dev counters, unchanged by the repair (post-fix
`voice.ts:210-213`; present at the same relative position pre-fix,
`voice.ts:188-190`):

> Dev counters. Voice failures are invisible without them: an ICE pair can
> die while both RTCPeerConnections still read "connected", so both sides
> look fine while no audio crosses.

The failure mode was diagnosed and written down. The detector for it did
not exist. `voice-audit.md` found zero `track.onmute`/`onunmute`/`onended`
handlers on a received track and zero periodic `getStats()` polls anywhere
in `frontend/src/` — the one `getStats()` call in the whole voice path was a
one-shot TURN probe at first connect. `libp2p-audit.md` found the same
shape one layer down: `connectedPeers` is "the only 'is this peer up'
authority", and the proof machinery that actually confirms a stream reaches
the far side (`confirmedStreams`) existed as a private `WeakSet` that no
event and no UI ever read. `sfu-audit.md` found it a third time: every
viewer-facing flag on the SFU path reports signalling state, never media
state — a `produce()` that resolved, a `trackAdded` that fired, a
`watchTransmission()` that returned. `relay-audit.md` found the same gap at
the transport-of-transports level: a registered rendezvous stream got no
liveness check at all, ever, because the read deadline was cleared
permanently on the first successful `REGISTER`.

## Detection layers added

The repair's shared shape: add exactly one detector per layer that samples
real traffic, and feed its output into the *existing* repair machinery
(blip grace, redial, teardown) rather than build a second one.

| Layer | Detector added | Feeds | Detection latency |
|---|---|---|---|
| P2P voice (`voice.ts`) | `getStats()` inbound-rtp `bytesReceived` sample on the existing 4 s reconcile tick; zero growth for `VOICE_MEDIA_STALL_MS` trips it | The existing blip ask (`VOICE_BLIP_GRACE_MS`) and wedge teardown (`VOICE_LINK_GRACE_MS`) grace — no new repair path | 8 s to flag the stall (`voice.ts:68`, `:514-527`, `:556-572`), then up to 5 s (passive ask) or 20 s (teardown) for the existing machinery to act |
| libp2p transport (`transport.ts`) | `streamProven`/`streamLost` events from the existing stream-confirmation machinery, mirrored to `transportState.provenPeers`; `droppedAt` map skips re-registering a peer still inside libp2p's own close window; probe release decoupled from the send-queue promise | `dropPeer`'s own redial (`PEER_REDIAL_DELAY_MS`); the reconcile tick; the UI-visible proven-peer mirror | Liveness drop redials in 3 s (`transport.ts:47`, `:588-590`); reconcile flap avoided inside a 1 s window (`CONNECTION_CLOSE_TIMEOUT_MS`, `:67`, `:1057-1064`); a stalled stream is now flagged at a stated ~10.6 s (`PEER_PROBE_RELEASE_MS`, `:90-91`) instead of doubling to 45-50 s |
| SFU (`mediasoup.ts`, `sfu/index.ts`) | `getStats()` sweep over every live consumer every 3 s; 2 consecutive samples with unmoved `bytesReceived` trips it | Closes and re-consumes the stalled producer; emits `trackStalled(peerId, source)` to the UI | ~6 s to detect a stalled consumer (`mediasoup.ts:267-274`, `:1310-1353`); a dead or backpressured peer is now reaped within 2 heartbeat intervals, 20 s by default, instead of up to 60 s or never (`sfu/index.ts:1139-1150`) |
| Relay (`relay/main.go` + `transport.ts` rendezvous half) | Mutual `PING` every 20 s once a stream is registered; a registered stream that sends nothing — not even a `PING` — for 60 s is closed | Stream close → `removeClient` → `PEER_LEFT` fan-out, which the client's existing redial paths already handle | Up to 60 s to catch an app layer wedged behind a live libp2p connection (`relay/main.go:198-215`; client side `transport.ts:114`, `:1799-1814`) — this class had no detector at all before |

None of the four layers added a second, parallel repair mechanism. Every
detector's output feeds a grace period, backoff, or teardown path that
already existed for a different trigger.

## Findings

58 findings across four audits: 11 voice, 15 libp2p, 20 SFU, 12 relay.
Ordered P0 first within each layer, matching each audit's own numbering.

### P2P voice — `VOICE-1` through `VOICE-11`

**VOICE-1 — P0.** Symptom (b): one peer stops being heard by everyone at
once. A DTLN worklet crash after init calls `handleFatal`, which suspends
the DTLN `AudioContext` and disconnects its graph, but the
`MediaStreamAudioDestinationNode` every `RTCRtpSender` still carries
survives with no input. RTP keeps flowing as digital silence;
`connectionState` never leaves `connected` (pre-fix `dtln-processor.ts:110-111`,
`:137-145`, `:247-266`; `voice-audit.md` finding 1). **Fixed** —
`DtlnProcessor` gained an `onFatal` callback slot (`dtln-processor.ts:25`,
`:149-156`); `LibP2PVoice` registers it in `join()` and re-runs `startMic()`
on the active input device when it fires (`voice.ts:886-898`).

**VOICE-2 — P0.** Symptom (b), per-peer and asymmetric. `startMic()` walked
`remotePeers` with an unguarded `await sender.replaceTrack(newTrack)`; one
peer's `InvalidStateError` (a torn-down transceiver) aborted the loop and
stranded every later peer in `Map` order on the old track (pre-fix
`voice.ts:684`, `:776-783`). **Fixed** — the per-peer body is now wrapped in
try/catch and continues on failure (post-fix `voice.ts:862-881`); the
duplicate unguarded loop in `setInputDevice` was deleted rather than
patched twice (`:634-644`).

**VOICE-3 — P0.** Symptom (b), and the finding that made 1, 2, 4, 5, 6, 7
all permanent instead of self-healing: no inbound-media watchdog existed at
all. `ontrack` attached the playback graph and returned; nothing polled
`getStats()`, nothing watched `onmute`/`onunmute` (pre-fix `voice.ts:889-893`,
`:930-948`). **Fixed** — the centerpiece fix. `RemotePeer` gained
`lastBytesReceived`/`lastBytesReceivedAt`; `pollInboundMedia()` samples the
inbound-rtp report on the existing 4 s reconcile tick; `linkIsHealthy()`
withholds its `okAt` refresh once bytes stall for 8 s, so the link falls
through to the pre-existing blip/wedge grace instead of a new path (verified
post-fix `voice.ts:68`, `:122-149`, `:367-383`, `:514-572`).

**VOICE-4 — P0.** Symptom (b), and the classic "granted mic late, never
heard" variant of (a). A renegotiation offer arriving in a signalling state
other than `stable`/`have-local-offer` hit `console.warn` and `return` —
never refreshing `okAt`, never tearing down, never asking for a redial, on
a link that reads `connected` the whole time (pre-fix `voice.ts:1064-1090`).
**Fixed** — that branch now calls `this.askForRedial(peerId, Date.now())`
before returning (post-fix `voice.ts:1220-1229`).

**VOICE-5 — P0.** Symptom (a) exactly: the link is perfect and the audio
graph is muted. Deafening sets the voice output gain to 0; leaving a call
reset the UI's `deafened` flag directly without restoring that gain, and
the next join seeded every peer's `GainNode` at `0 * anything` (pre-fix
`call.svelte.ts:257`, `:474`; `voice.ts:1029-1030`). **Fixed** —
`leaveCall()` now calls `setDeafened(false)` before `_voice.leave()`,
guarded so a non-deafened leave stays silent and does not play the
undeafen chime (verified post-fix `call.svelte.ts:249-255`).

**VOICE-6 — P0.** Symptom (a) on first join. `_joinCall()` called
`_syncVoiceRoster()` while `transportState.inCall` was still `false`, so the
roster sync sent an empty `callPeers` and the default-deny admission guard
dropped every inbound offer for the whole `await _video.join(...)` window —
up to the full SFU-join timeout (pre-fix `call.svelte.ts:155-176`;
`transport.svelte.ts:1927-1930`). **Fixed** — `inCall` and `callRoomCode`
are now set before the first `_syncVoiceRoster()` call, ahead of
`_video.join()` (verified post-fix `call.svelte.ts:165-168`).

**VOICE-7 — P1.** Symptoms (b) after a tab switch or OS audio interruption,
and (a). The playback `AudioContext` was resumed once, in `join()`; a later
OS/browser suspend was never undone, while the visibility handler resumed
only the separate analyser context — so tiles kept animating speaking rings
while the user heard nothing (pre-fix `voice.ts:222-229`;
`speakers.svelte.ts:344-348`). **Fixed** — `reconcileLinks()` resumes
`audioCtx` on its existing 4 s tick whenever it finds it suspended (verified
post-fix `voice.ts:367-374`).

**VOICE-8 — P1.** The finding that made 1-7 look invisible. `voice-peer-left`
was declared and had three live UI consumers, but `voice.ts` never emitted
it; six of seven teardown paths published nothing at all (pre-fix
`voice.ts:243-245`, `:336-349`, `:448-451`, `:847`, `:1107`; `types.ts:26-47`).
**Fixed** — `teardownRemotePeer()` now emits `voice-peer-left` with the full
peer id from the single choke point every teardown path passes through
(verified post-fix `voice.ts:1194-1198`); every status that names a peer
carries the full id, not the sliced short form; `voice.svelte.ts` wires
`_voice.on("status", ...)` into `_transport.announce()`, which the three UI
consumers actually listen on and which did not exist before this fix
(verified post-fix `voice.svelte.ts:97-98`).

**VOICE-9 — P1.** Output device selection had no audible effect: it routed
the pinned-silent, detached `<audio>` elements, while all real output left
through `audioCtx.destination`; one bad element's rejected `setSinkId` also
aborted the whole loop (pre-fix `voice.ts:598-605`, `:1036-1037`). **Fixed**
— `setOutputDevice` now calls `setSinkId` on the `AudioContext` itself
behind a feature test, and the per-element loop continues past one
rejection (verified post-fix `voice.ts:679-694`).

**VOICE-10 — P1.** Symptom (b), "the blip that never comes back". The ICE
restart offer's `sendSignal` result was discarded with `void`, unlike the
initial offer and the answer, both of which check delivery (pre-fix
`voice.ts:975`). **Fixed** — the restart chain now checks the boolean
result and falls through to `askForRedial` on `false` (verified post-fix
`voice.ts:1083-1097`).

**VOICE-11 — P2.** Two sub-items. A paused `<audio>` element with no
`play()` call and no `pause` listener would go silent forever with no
detector. **Fixed** — `setupRemoteAudio` now calls
`remote.audio.play().catch(() => {})` (verified post-fix `voice.ts:1165`).
The second sub-item — whether a transport `disconnect` should get a grace
period instead of an immediate teardown — was resolved with no code change:
the libp2p fixer confirmed `disconnect` only fires on a genuinely dead
connection after their own finding-2/3 fixes, so the immediate teardown is
correct by design.

### libp2p transport — `LIBP2P-1` through `LIBP2P-15`

**LIBP2P-1 — P0.** Symptom (a) exactly: a peer marked connected with zero
proof any frame can flow. `registerPeer` added a peer to `connectedPeers`
on `peer:identify` or reconcile with no check that a frame could reach it;
the real proof (`confirmedStreams`) was a private `WeakSet` with no event
and no UI (pre-fix `transport.ts:790-801`, `:222`, `:1326`). **Fixed** —
`TransportEvents` gained `streamProven`/`streamLost`, emitted from
`confirmOutboundStream` (proof gained) and `cleanupPeerStream`/
`resetOutboundStream` (proof withdrawn, only if it had actually been
proven); mirrored into `transportState.provenPeers` in
`transport.svelte.ts`.

**LIBP2P-2 — P0.** Symptoms (a) and (b), and the reason (b) is permanent.
`dropPeer` deleted `connectedPeers` before closing the connection, so
`peer:disconnect`'s own dedup guard (`if (!connectedPeers.has(id)) return`)
swallowed the redial that should have followed (pre-fix `transport.ts:909`,
`:492`, `:507-508`). **Fixed** — `dropPeer` now schedules
`setTimeout(() => this.redialPeer(peerId), PEER_REDIAL_DELAY_MS)` itself,
gated on `!intentionalDisconnect` (verified post-fix `transport.ts:47`,
`:588-590`).

**LIBP2P-3 — P0.** Symptom (a): connect, chime, carry nothing, disconnect,
repeat every few seconds. `dropPeer` called `connection.close()` without
awaiting it; libp2p's graceful close can take up to 1 s, during which
`getConnections()` still returns the dying connection, and the reconcile
tick would re-register it into a connection that was already closing
(pre-fix `transport.ts:913-915`, `:928`, `:944-947`). **Fixed** — a
`droppedAt` map set in `dropPeer`, checked in `reconcileConnections` against
`CONNECTION_CLOSE_TIMEOUT_MS = 1_000` (verified post-fix `transport.ts:67`,
`:1057-1064`).

**LIBP2P-4 — P1.** Every extra connection to an already-connected peer
(routine under glare, since both sides keep both connections on purpose)
aborted an already-confirmed stream, because `registerPeer` called
`cleanupPeerStream` unconditionally on every `peer:identify` (pre-fix
`transport.ts:414-430`, `:794`). **Fixed** — guarded to
`if (!this.connectedPeers.has(peerId)) this.cleanupPeerStream(peerId)`
(verified post-fix `transport.ts:886`); a returning peer's stale stream is
still handled by the existing reset-on-new-connection path.

**LIBP2P-5 — P1.** Peer dial backoffs carried no jitter, so both sides of a
pair retried the same relay-reservation race in lockstep and lost it
repeatedly (pre-fix `transport.ts:1063-1069`, `:988-994`, `:1629-1633`,
`:508`). **Fixed** — the existing `wait + Math.random() * wait * 0.3` shape
(already used for the relay dial) applied to `retryMissingRoomPeers`,
`upgradeRelayedPeers`, and `dialPeer`'s retry (verified post-fix
`transport.ts:1254`, `:1860`).

**LIBP2P-6 — P1.** A hidden tab had zero liveness detector
(`probeSilentPeers` returned early on `document.hidden`) and a stale relay
badge (`upgradeRelayedPeers` returned before its status refresh) — exactly
the mobile-backgrounded-PWA case (pre-fix `transport.ts:831`, `:970`).
**Fixed** — `probeSilentPeers` scales its silence threshold ×4 while hidden
instead of returning early (verified post-fix `transport.ts:930-931`);
`upgradeRelayedPeers` always refreshes `updateRelayedStatus` and skips only
the dial attempt while hidden.

**LIBP2P-7 — P1.** After winning a direct-WebRTC upgrade, the code deleted
the proven `liveConnections` entry rather than repointing it, so the next
stream open used `dialProtocol`'s arbitrary connection pick — which the
file's own comment says can land back on the very circuit just upgraded
away from (pre-fix `transport.ts:1028-1031`, `:1037`, `:1202`). **Fixed** —
`upgradeToDirect` now sets `liveConnections` to the actual direct connection
found via `getConnections().find(c => c.direct)` (verified post-fix
`transport.ts:1170-1172`).

**LIBP2P-8 — P1.** `writeFrame` reported success the instant `stream.send()`
returned, even when that return was `false` (buffered, not flushed) —
contradicting the module's own stated invariant that a `true` deletes a
persisted offline-queue entry (pre-fix `transport.ts:1349-1354`, `:133-140`).
**Fixed** — `writeFrame` is now `async` and awaits `onDrain()` before
resolving true/false (verified post-fix `transport.ts:1491`).

**LIBP2P-9 — P1.** `relayed` status was never re-evaluated on connection
close; no `connection:close` listener existed anywhere in the file (pre-fix
`transport.ts:1730-1760`, absence confirmed by the audit). **Fixed** — a
`connection:close` listener added beside the existing `connection:open`
(verified post-fix `transport.ts:544-548`).

**LIBP2P-10 — P1.** The miss-release timer in `probeSilentPeers` was chained
to the `send()` promise, which can sit on the pending queue for the full
8-attempt confirm budget — doubling the stated 5 s ping timeout to roughly
10.6 s per miss, and pinning forever if the queue never drained (pre-fix
`transport.ts:841-844`, `:611-615`). **Fixed** — decoupled into an
independent `setTimeout` on a new stated constant,
`PEER_PROBE_RELEASE_MS = STREAM_CONFIRM_INTERVAL_MS * STREAM_CONFIRM_ATTEMPTS
+ PEER_PING_TIMEOUT_MS` (verified post-fix `transport.ts:90-91`, `:948-961`).

**LIBP2P-11 — P2.** `reconcileConnections` never removed a peer whose
connection was lost across a node restart; the resident `connectedPeers`
entry leaked until `connect()` cleared the whole set (pre-fix
`transport.ts:938-951`). **Fixed** — after the reconcile loop, any
`connectedPeers` entry with no backing connection is now dropped via
`dropPeer`, paired with LIBP2P-2's redial so it does not strand anything
(fix-libp2p-report).

**LIBP2P-12 — P2. Left.** See "What was deliberately left" below.

**LIBP2P-13 — P2.** `debugStats.identifies`, `.connects`, and
`.staleConnectionsClosed` had no writer anywhere in the tree, despite the
block's own comment naming exactly these symptoms as the reason the
counters exist (pre-fix `transport.ts:226-243`). **Fixed** — `identifies`
incremented in the `peer:identify` handler, `connects` in `registerPeer`;
`staleConnectionsClosed` deleted after confirming zero writers or readers
repo-wide (fix-libp2p-report).

**LIBP2P-14 — P2, latent.** `runOnLimitedConnection: true` was applied
inconsistently across the four `DIRECT_MSG_PROTOCOL` stream-open paths,
currently harmless because the relay grants circuits no limits, but a
latent fleet-scale hazard if that ever changes (pre-fix `transport.ts:1207-1229`,
`:378-388`). **Fixed** — the option added to every remaining call site
(verified post-fix `transport.ts:445`, `:1354`, `:1368`, `:1376`).

**LIBP2P-15 — P2.** `waitForRelayReservation` removed its listener from
`this.node` at exit time rather than the node it attached to, so a
concurrent reconnect mid-wait could resolve the old promise from the new
node's addresses (pre-fix `transport.ts:1692-1727`). **Fixed** — captures
`const node = this.node` once at the top of the promise body and uses it
for every read and listener call inside (fix-libp2p-report).

### SFU / mediasoup — `SFU-1` through `SFU-20`

**SFU-1 — P0.** Symptom (a): the call looks established, voice works, no
camera or share ever appears again. A mid-call `ms:error{reason:
"transport-timeout"}` from `reapTransport` was treated identically to a
session refusal — `failSession` latched `this.refusal` before the message
was even inspected — killing the send side because of a recv-side DTLS
failure (pre-fix `sfu/index.ts:437-449`; `mediasoup.ts:785-788`, `:944-953`).
**Fixed** — the server now sends `direction` with that reason; the client
routes it through `handleTransportTimeout()`, which rebuilds only the
affected transport and never sets `this.refusal` (verified post-fix
`mediasoup.ts:685`, `:1002-1006`).

**SFU-2 — P0.** Symptoms (a) and (b): a transport dies under a healthy
socket and the retry ladder never rebuilds anything, because
`sessionIsLive()` — the gate every rejoin path checks — was exactly
`socket OPEN && device != null`, both still true after a transport failed
(pre-fix `mediasoup.ts:516-520`, `:550-557`). **Fixed** — `sessionIsLive()`
now also returns `false` when `this.refusal` is set or either transport's
`connectionState` is `failed`/`disconnected`/`closed` (verified post-fix
`mediasoup.ts:589-598`).

**SFU-3 — P0.** Symptom (a): a black tile that says "watching". The server
created every consumer with `paused: false` and forwarded RTP before the
client's recv-transport DTLS handshake finished, so every packet in that
window was discarded and nothing ever requested a fresh keyframe (pre-fix
`sfu/index.ts:838`; `mediasoup.ts:900-918`). **Fixed** — consumers are now
created `paused: true`; the client sends a new `ms:resume-consumer` frame
after `recvTransport.consume()` resolves, and the server's `consumer.resume()`
forces a fresh keyframe request (verified post-fix `sfu/index.ts:901`,
`:983-991`; `mediasoup.ts:19-25` `MSResumeConsumer` shape referenced in the
report).

**SFU-4 — P0.** Symptom (b) on the SFU leg: closing a screen share's audio
producer tore down the viewer's whole watch state and nulled the video
track too, because `trackRemoved` carried no track kind (pre-fix
`types.ts:156`; `mediasoup.ts:858`; `transmission.svelte.ts:65`). **Fixed**
— `MSProducerClosed` and `trackRemoved` now carry `kind`; the
`ms:producer-closed` handler tears down watch state only when no screen
consumer for that peer survives (verified post-fix `sfu/index.ts:87-97`,
`:769-791`; UI wiring in `transmission.svelte.ts` confirmed post-fix at
`:28-42`, cleared per-source on the next matching `trackAdded`).

**SFU-5 — P0.** Symptoms (a) and (b): nothing on the SFU path detects that
media stopped flowing — no `getStats`, no `bytesReceived` reference
anywhere in `mediasoup.ts` or `sfu/index.ts` (pre-fix, absence confirmed by
the audit). **Fixed** — a `getStats()` sweep every 3 s over live consumers;
2 consecutive samples with unmoved `bytesReceived` closes and re-consumes
the producer and emits `trackStalled(peerId, source)` (verified post-fix
`mediasoup.ts:267-274`, `:1310-1353`).

**SFU-6 — P0.** Symptom (a): a fresh joiner is handed a stale producer id.
All server cleanup hung off `ws.on("close")`, which a vanished client never
sends; the 30 s heartbeat also skipped any socket flagged `backpressured`,
so a peer that was both paused and gone lived until the kernel gave up on
the TCP connection — sometimes indefinitely (pre-fix `sfu/index.ts:1088-1105`,
`:1367-1387`). **Fixed** — heartbeat interval now env-configurable
(`HEARTBEAT_INTERVAL_MS`, default 10 s), and a socket stuck `backpressured`
past `BACKPRESSURE_DEADLINE_MS` (2× the heartbeat interval) is terminated
instead of skipped forever, extracted into a unit-testable
`sfu/heartbeat.ts` decision (verified post-fix `sfu/index.ts:1139-1150`).

**SFU-7 — P0.** Symptom (a): one participant is audible and never sends or
receives video. The SFU's `ClientTransportOptions` never carried
`iceServers`, so a network that blocked outbound UDP and permitted only
80/443 had no path to the SFU at all, while voice survived the same network
through TURN on 5349/tcp (pre-fix `sfu/index.ts:19-25`; `mediasoup.ts:692-699`,
`:738-745`). **Fixed** — `iceServers: getIceServers()` now passed into both
`createSendTransport` and `createRecvTransport`; the relay fixer closed the
exposed prerequisite (TURN credential refresh, see `RELAY-3`) in the same
wave.

**SFU-8 — P1.** A camera consume was fire-and-forget with no `.catch()`, no
surfaced error, and no retry — a lost consume left an avatar forever while
`ms:new-producer` never repeats (pre-fix `mediasoup.ts:833`). **Fixed** —
`consumeProducerWithRetry()` retries once, 3 s later, and emits `error` on
final failure (verified post-fix `mediasoup.ts:1221-1225`).

**SFU-9 — P1.** Late replies were matched FIFO by response type with no
correlation id, so a timed-out request's answer could resolve the next
request of the same type — for `ms:consumer-options` this attached one
peer's stream to another peer's tile (pre-fix `mediasoup.ts:790-797`,
`:918-928`). **Fixed** — replaced with per-request correlation by a
server-echoed `requestId` (`this.pendingById`) (verified post-fix
`mediasoup.ts:228-231`, `:1015-1022`).

**SFU-10 — P1.** The same FIFO-by-type queue serialized every consume of
one type, so a busy room's replay paid the full 10 s timeout per dead
producer ahead of it in line — compounding into the server's own 20 s
transport-connect reap (pre-fix `mediasoup.ts:955-960`; `sfu/index.ts:220-223`).
**Fixed** — resolved by the same `requestId` change as `SFU-9`: consumes no
longer share a per-type chain and run concurrently.

**SFU-11 — P1.** A partly failed screen-share publish (video producer
created, audio producer throws) orphaned the live video producer, because
`this.producers.set(source, produced)` ran only after the whole loop
finished (pre-fix `mediasoup.ts:615-649`). **Fixed** — `publish()` now
records each producer as it is created; a later failure in the same call
closes and signals `ms:close-producer` for every producer that already
succeeded (fix-sfu-report).

**SFU-12 — P1.** `watchTransmission` counted success when *any* producer in
the loop consumed — audio succeeding while video failed still set
`watchingTransmissionPeerId`, leaving a permanent connecting tile that
retry logic refused to touch again (pre-fix `mediasoup.ts:338-355`).
**Fixed** — the early-return guard and the success check are now scoped to
a video consumer specifically (fix-sfu-report).

**SFU-13 — P1. Fixed (interim only) — see "What was deliberately left".**
Build-time SFU placement plus a cached PWA bundle can put two participants
on different SFU nodes, so voice works and no camera or share ever appears
(pre-fix `sfu-pool.ts:33-68`).

**SFU-14 — P1.** Every viewer-facing sharing/watching flag was derived from
signalling, never from media state, so a stuck send transport or a stalled
consumer left the UI asserting a state the media path did not back up
(pre-fix, table in `sfu-audit.md` finding 14). **Fixed** — `trackStalled`
wired into `transmission.svelte.ts` (`videoStalled`/`screenStalled` on
`ParticipantState`, cleared by the next matching `trackAdded`); the call
grid tile in `VoiceVideoCallView.svelte` renders a "Frozen — reconnecting"
overlay instead of a silently-stalled live-looking tile (verified post-fix
`transmission.svelte.ts:29-30`, `:45-53`).

**SFU-15 — P1.** The video error banner (`transportState.error`) had no
auto-clear, and `healed` cleared it only on exact string equality with two
specific messages — every refusal string and both transport-failure strings
fell outside that set (pre-fix `transmission.svelte.ts:150-162`). **Fixed**
— routed through `setErrorWithAutoClear`, tracking which message the video
transport itself set rather than comparing strings (fix-sfu-report /
fix-statusui-report).

**SFU-16 — P2.** `pauseVideo`/`resumeVideo`/`isPaused`/`isPublishing`/
`getAudioTrack` had no wire message and no caller anywhere in the app —
fully dead, unreachable API surface (pre-fix `mediasoup.ts:303-323`,
`:398-404`; confirmed zero callers by the audit). **Fixed** — all five
deleted from `MediasoupVideo`, `VideoTransport`, and their two re-export
wrappers in `call.svelte.ts` (fix-sfu-report / fix-voice-report).

**SFU-17 — P2.** `sfuPeerIds` was written in four places and read nowhere,
and never shrank on `trackRemoved` (pre-fix `transmission.svelte.ts:38-123`).
**Fixed** — deleted entirely, field and all four write sites, after
confirming zero readers repo-wide (fix-statusui-report).

**SFU-18 — P2.** The server's per-producer viewer `Set` was declared,
initialized, and deleted from, but never added to — always empty — and the
same loop scanned the whole room instead of breaking once it found the
owning producer (pre-fix `sfu/index.ts:121-128`, `:925-936`). **Fixed** —
`handleConsume` now adds to the set; the loop breaks unconditionally once
the owning producer is found (fix-sfu-report).

**SFU-19 — P2.** `startScreenShare`'s own `onended` handler for the
stop-sharing sound was silently overwritten by `mediasoup.ts`'s own
assignment to the same property (pre-fix `call.svelte.ts:430`;
`mediasoup.ts:290`). **Fixed** — the duplicate assignment removed from
`mediasoup.ts` (fix-sfu-report).

**SFU-20 — P2. Fixed (partial).** Five stale claims across docs and tests
described behaviour the code did not have. **Fixed**: the `sfu/index.test.ts`
header comment advertising a non-existent `canConsume` test, corrected, and
the regression test the finding itself asked for (`transport-timeout` does
not latch a permanent refusal) added; `relay/turn.go`'s stale
"client refreshes before expiry" comment corrected by the relay fixer.
**Left**: three of the five inaccuracies live in `docs/spec.md` ("one full
automatic rejoin", transport creation timing, early-queue behaviour) —
outside every fixer's owned files this wave, with no clear single owner.

### Relay — `RELAY-1` through `RELAY-12`

**RELAY-1 — P0.** Symptoms (a) and (b), hitting one peer while the rest of
a call stays fine. `relayResources()` lifted three of go-libp2p's four relay
ceilings and left `MaxCircuits` at the upstream default of 16 combined
circuits per peer; the 17th relayed connection of any peer — reachable from
17 online contacts, since every DM room dials every online contact — is
refused (pre-fix `relay/main.go:1010-1018`; go-libp2p `MaxCircuits: 16`
default). **Fixed** — `res.MaxCircuits = connMgrHigh` added to
`relayResources()` (verified post-fix `relay/main.go:1197`).

**RELAY-2 — P0.** Symptom (a), including the "looks connected, carries
nothing" shape. `PEERS` replies had no size bound; a room past roughly 297
distinct peer ids built a frame over the client's 16 KiB fatal-abort
threshold, and the client's reconnect-then-re-REGISTER cycle re-triggered
the same oversized frame forever (pre-fix `relay/main.go:606-621`, `:639`;
`transport.ts:1550-1558`). **Fixed** — `PEERS` replies now chunk into
frames of at most `maxPeersPerFrame = 128` peer ids, sized to stay under the
relay's own 8192-byte inbound cap; `sendTo` self-checks and drops+logs if it
ever exceeds that (verified post-fix `relay/main.go:73-85`, `:640-656`).

**RELAY-3 — P0.** Symptom (a) for mobile/CGNAT peers, (b) on calls that
outlive the credential. TURN credentials mint a 2 h TTL; the comment
claiming "the client refreshes well before expiry" was false — the one call
site ran once, at `connect()`, and never rescheduled (pre-fix
`relay/turn.go:83-87`; `transport.svelte.ts:2912`; `ice-server-list.ts:44-49`,
`:59-102`). **Fixed** — `refreshTurnCredentials()` now reads `ttl` from the
response and re-arms itself via `setTimeout` at half the TTL, indefinitely;
the `relay/turn.go` comment corrected to match (fix-relay-report).

**RELAY-4 — P1.** Every `REGISTER` refusal but one returned success
indistinguishably from a real join; the per-stream 1024-room cap let a
single peer id hold 32 streams × 1024 rooms, so 7 identities from one host
could exhaust the 200,000 global registration ceiling in roughly 50 minutes
and silence every peer's discovery for the life of the process (pre-fix
`relay/main.go:549-593`, `:73-82`). **Fixed** — refused `REGISTER`s (room
cap, global cap, rate limit) now get an explicit `REGISTER_FAILED` frame,
additive on the wire; the room-cap check now sums across every stream a
peer id holds (`roomsHeldByPeer`), closing the 32× amplification (verified
post-fix `relay/main.go:40`, `:607-618`, `:661-664`, `:1097-1135`). The one
refusal that must stay silent by design — the empty-room-probe budget, so
it never becomes a room-code oracle — was deliberately left silent.

**RELAY-5 — P1.** Symptom (b): a registered rendezvous stream had no
liveness check of any kind; the read deadline was cleared permanently on
the first successful `REGISTER` (pre-fix `relay/main.go:918-922`;
`transport.ts:1564-1568` swallowed every parse error with a bare `catch{}`).
**Fixed**, both halves. Relay side: a registered stream now gets a 60 s
liveness deadline (`rendezvousLivenessTimeout = 3 × rendezvousPingInterval`,
`20 s`) instead of none (verified post-fix `relay/main.go:198-215`,
`:1061-1062`). Client side: `transport.ts` now sends a no-op `PING` every 20
s while registered (`RENDEZVOUS_PING_INTERVAL_MS`, verified post-fix
`transport.ts:114`, `:1799-1814`), and the parse-error handler now aborts
the stream and lets the close handler reconnect instead of swallowing the
frame silently (verified post-fix `transport.ts:1745-1767`).

**RELAY-6 — P1.** Symptom (b), "it never comes back". A `REGISTER` for a
room the stream already held returned early without sending `PEERS`, so a
client with a stale membership view had no resync primitive short of a
`UNREGISTER`/`REGISTER` churn cycle visible to every other member (pre-fix
`relay/main.go:554-557`). **Fixed** — a repeat `REGISTER` for an
already-joined room now resends that room's `PEERS` instead of no-opping
(fix-relay-report, `TestRepeatedRegisterResyncsPeers`).

**RELAY-7 — P1.** Symptom (b), partial form. `startRendezvous` had no
in-flight guard across its four call sites; a relay flap could race two
dials, and the losing stream was orphaned — never referenced, never
`UNREGISTER`ed, and (since `addStream` never supersedes) still counted as a
room member, which suppressed `PEER_JOINED`/`PEER_LEFT` for the live stream
(pre-fix `transport.ts:1504-1526`). **Fixed** — `rendezvousStarting` guards
against a concurrent start, and any previous stream still held in
`this.rendezvousStream` is aborted before being superseded (verified
post-fix `transport.ts:183`, `:1672-1707`).

**RELAY-8 — P2.** The oversized-frame log line bypassed every log budget
via a bare `log.Printf`, at stream-open rate under abuse (pre-fix
`relay/main.go:941-943`). **Fixed** — routed through the existing budgeted
`warn()` (verified post-fix `relay/main.go:1077-1080`).

**RELAY-9 — P2.** `TRUSTED_PROXY_CIDRS` defaulted to the whole RFC1918
space, so any container on the shared docker network — not just the
reverse proxy — could forge its own rate-limit bucket via
`X-Forwarded-For` (pre-fix `relay/pluginproxy.go:155-176`). **Fixed** —
reframed as production-required and narrowed to the proxy's single address
in `.env.example` and `deploy/README.md`; doc-only, per the audit's own
smallest fix (fix-relay-report).

**RELAY-10 — P2.** A bind failure on the HTTP API server was only logged,
leaving the process running with a healthy rendezvous and no
`/turn-credentials` endpoint at all (pre-fix `relay/main.go:1187-1191`).
**Fixed** — `log.Fatalf` instead of `log.Printf`, so
`restart: unless-stopped` recovers it (verified post-fix `relay/main.go:1347`).

**RELAY-11 — P2.** Nothing enforces the single-replica constraint the
registry and mailbox depend on; a second replica would silently split the
world while sharing one relay identity key (pre-fix `relay/main.go:455-460`,
`:1085-1086`). **Fixed** — the boot log states the one-replica requirement
next to the printed PeerID; `deploy/README.md` documents the hazard
(fix-relay-report).

**RELAY-12 — P2.** `totalCapLogged` was set on the first ceiling breach and
never cleared, so every later episode logged nothing for the life of the
process (pre-fix `relay/main.go:452`, `:558-566`). **Fixed** — cleared once
`r.total` drops back under the ceiling, folded into the `RELAY-4` change
(verified post-fix `relay/main.go:831-833`).

## What was deliberately left

Three items remain open, each with a stated real fix.

**SFU-13 — SFU node placement is still decided at build time.**
`sfu-pool.ts` still reads `import.meta.env.VITE_SFU_URLS` at module load
(verified post-fix `sfu-pool.ts:33-42`, unchanged): adding a satellite SFU
still needs a frontend rebuild, and a client on a stale cached PWA bundle
still computes a different pool than a client on the new one. Left because
the real fix — serving the SFU pool at runtime from the relay, next to
`/turn-credentials` — is new infrastructure (a relay HTTP endpoint plus a
`sfu-pool.ts` change to fetch it), not a single-file smallest fix, and no
fixer's ownership grant covered it this wave. What shipped instead is the
audit's own named interim guard: `ms:capabilities` now carries
`roomPeerCount` (verified post-fix `mediasoup.ts:32`, `:290`, `:472-474`), so
a client alone in a room it expects company in can at least say so. The
real fix is: build the runtime pool endpoint on the relay and switch
`sfuPool()` to fetch it.

**LIBP2P-12 — a lost rendezvous `UNREGISTER` has no replay path.**
`leaveRoom()` still removes the room from `joinedRooms` before sending
`UNREGISTER` (verified post-fix `transport.ts:610-616`, unchanged from the
audit's description of the pre-fix code): a lost `UNREGISTER` frame has
nothing to replay, because the room is no longer in the set the reconnect
replay loop iterates. The relay keeps naming the client as a room member
until a full reconnect. Left because the task's scope this wave authorized
one-line P2 fixes, and the audit's own smallest fix — a `pendingUnregister`
`Set`, written at `leaveRoom`, flushed beside the existing `REGISTER`
replay — is two call sites, not one line. The real fix is exactly that: add
`pendingUnregister: Set<string>`, insert into it when `rendezvousSend`
returns silently null, and flush it alongside the `REGISTER` replay in
`startRendezvous`.

**SFU-20 (partial) — three stale claims remain in `docs/spec.md`.** "One
full automatic rejoin" (the ladder is now unbounded, capped at 30 s per
rung), the claim that send/recv transports are created after the router
capabilities exchange (they are created lazily, on first publish or
consume), and the claim that early `ms:new-producer` signals queue until
the recv transport is ready (they queue until `device` is non-null, drained
before any transport exists). Left because `docs/spec.md` was outside every
fixer's owned-files grant this wave, and no one volunteered to touch a file
with ambiguous ownership. The real fix is a three-line documentation
correction, unblocked by any code change.

## How to reproduce a connected-but-silent failure

`frontend/src/lib/transport/faults.ts` is dev-only fault injection, driven
from a test via `window.__faults`. Verified against the current file
(`faults.ts:1-138`):

- `__faults.set({ blockWebrtcDial: true })` fails the direct `/webrtc` dial
  so a pair falls back to a plain relay circuit — the reservation race that
  produces `LIBP2P-5`'s lockstep retry and `LIBP2P-7`'s "upgrade hands
  traffic back to the circuit it just left" failure.
- `__faults.set({ suppress: ["connect"] })` lets a connection live while its
  `connect` event never fires — the shape `LIBP2P-1`'s proof gap needed:
  a connection the app never gets confirmation for.
- `__faults.set({ blockDial: ["*"] })` makes every peer undialable — force a
  liveness drop, then assert the redial `LIBP2P-2` added actually fires.
- `__faults.set({ drop: [...] })` drops specific outbound wire message
  types by name — targeted reproduction of a dropped `VoiceSignal` frame
  (`VOICE-4`) or a discarded ICE-restart offer (`VOICE-10`).
- `__faults.set({ dropProbability: <0..1> })` drops outbound frames at
  random — a general stand-in for `LIBP2P-8`'s backpressure case.
- `__faults.set({ blockSfu: true })` fails the SFU socket open in
  `connectSfu`. This is the only SFU-facing fault. It does not reproduce a
  mid-call `ms:error`, a failed transport, or a stalled consumer —
  `SFU-1`, `SFU-2`, and `SFU-5` have no fault-injection regression guard for
  that reason, and none was added this wave.

No fault in this file touches the relay process; `RELAY-1` through
`RELAY-12` are exercised by `relay/main_test.go`, not `faults.ts`.

For a live, connected-but-silent failure that fault injection cannot
reproduce (a real DTLN crash, a real network path fault), the voice audit's
own diagnostic still applies. Capture `debugVoice()` (`voice.ts`) plus one
`pc.getStats()` inbound-rtp sample from **both** ends of the failing link
at the same moment. Read it like this: if the listener's inbound-rtp
`bytesReceived` is stalled while the sender's outbound-rtp `bytesSent` is
still climbing, the fault is on the listener's side (the class `VOICE-4`,
`VOICE-5`, and `VOICE-7` cover: a dropped offer, a zeroed gain node, a
suspended playback context). If both `bytesReceived` and `bytesSent` are
stalled, the fault is on the sender's side (the class `VOICE-1` and
`VOICE-2` cover: a dead DTLN worklet, a rejected `replaceTrack`).

## Verification

Final state of the wave, after every fix above landed: the frontend suite
passed 869 tests, and `svelte-check` reported no errors across 5038 files.
The relay's Go suite passed `go test ./... -race` clean. The SFU's own test
suite passed 5 of 5. The production build completed successfully.

## Open questions

Condensed from the four audits' own "Gaps" sections. Each is a question the
audit could not settle from the repository alone, with the evidence that
would settle it.

**Voice.** Which of findings 1, 2, 4, 5, 7 a given failure report actually
hit — settled by a `debugVoice()` + both-ends `getStats()` capture (now
documented above). Whether the muted-`<audio>`-element Chromium workaround
holds in every target browser — settled by attaching the element to the
DOM in a scratch build and comparing `bytesReceived` growth, or by the
target-browser matrix in `docs/spec.md`. Whether `AudioContext.setSinkId`'s
Chromium-only status needs a Firefox/Safari fallback — needs the project's
browser-support policy. Whether moving `inCall = true` earlier disturbs any
other reader of that flag — settled by enumerating its readers (this sits
inside the `VOICE-6` fix and was not separately re-audited). The DTLN
worklet's real-world crash rate — settled by a
`[DTLN] DTLN processor crashed` line in a real session log. Whether the 8 s
media-stall threshold is right for TURN-relayed links on a poor network —
settled by a `bytesReceived` trace across a deliberately degraded relay
path.

**libp2p.** Direct-WebRTC close latency for a killed peer — settled by
timestamping the `peer:disconnect` handler against a killed peer process,
desktop and mobile. Whether `live.newStream` inherits libp2p's protocol
negotiation timeout — settled by reading `@libp2p/interface`'s
`Connection.newStream` and the yamux muxer's `newStream`. Whether
`node.stop()` can hang, wedging reconnection — settled by racing it against
a timeout in a dev build under rapid reconnect churn. Observed frequency of
the reconcile-flap window `LIBP2P-3` closed — settled by
`debugStats.disconnects` against `debugStats.livenessDrops` under injected
drops. Which of findings 1-4 dominates symptom (a) in the field — settled
by `debugStats.confirmFailures`, `.outboundResets`, and the
disconnects-to-liveness-drops ratio, all already exposed via the dev
console.

**SFU.** Which of findings 1-7 fires in a given user report — settled by a
browser console log plus `chrome://webrtc-internals` for the SFU
transports, distinguishing zero `bytesReceived` (finding 3) from frozen
non-zero (finding 5). Real keyframe interval of the deployed encoders —
settled by `keyFramesDecoded` timing on a shared static window. How often
the backpressure pause actually engages — settled by a counter on the pause
path. Observed SFU split-brain rate — depends on the service-worker update
policy, outside every audit's scope. Whether the failing peer's network
blocks high TCP as well as UDP — settled by `nc -z <ANNOUNCED_IP> 61000`
from that peer's network.

**Relay.** Whether real rooms reach the 16-circuit ceiling `RELAY-1` fixed
— settled by `GOLOG_LOG_LEVEL=relay=debug` grepped for
`too many connections from/to`, or counting `/p2p-circuit` connections in a
browser during a multi-peer call. coturn's exact behaviour on a Refresh
with an already-expired REST username — settled by minting a 60 s-TTL
credential and watching coturn's log across expiry. Whether the client's
yamux keepalive matches the relay's confirmed 30 s/10 s/10 s — settled by
reading `@chainsafe/libp2p-yamux`'s resolved config.
