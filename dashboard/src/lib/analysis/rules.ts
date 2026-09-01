/**
 * The deterministic rule table: metadata only, no detection logic.
 *
 * Every id here is grounded in a real failure mode of this codebase and is
 * derivable from the events the flight recorder emits (see
 * `frontend/src/lib/telemetry/`). `findings.ts` is the only module that reads
 * `capture.timeline` and decides when a rule fires; this file just names what
 * each rule means, once, so the Findings view and the AI prompt pack can
 * quote the same sentence.
 *
 * Prose here follows ASD-STE100: short sentences, active voice, no `-ing`
 * verb forms, and only `can` / `will` / `must` as modals.
 */

export type FindingId =
  | "relay-reservation-never-completed"
  | "relay-unreachable"
  | "relay-flapping"
  | "rendezvous-wedged"
  | "turn-missing-and-needed"
  | "connected-not-proven"
  | "asymmetric-link"
  | "upgrade-starved"
  | "liveness-flap"
  | "stream-confirm-starved"
  | "room-view-split"
  | "message-rejected"
  | "sync-stalled"
  | "voice-never-connected"
  | "voice-media-stalled"
  | "voice-relayed-only"
  | "voice-restart-loop"
  | "sfu-session-latched"
  | "sfu-transport-timeout"
  | "sfu-rejoin-loop"
  | "sfu-consumer-stalled"
  | "sfu-room-split"
  | "sfu-placement-disagreement"
  | "clock-skew"
  | "fault-injection-active"
  | "unconfigured-instance"
  | "storage-locked-writes"
  | "capture-incomplete"
  | "relay-close-unclean"
  | "peerconnection-leak"
  | "uncaught-error"
  | "producer-never-consumed"
  | "turn-unreachable";

export interface Rule {
  id: FindingId;
  title: string;
  severity: "block" | "warn" | "info";
  /** One sentence: what it means. */
  meaning: string;
  /** One sentence: what to change. */
  remedy: string;
  /** What the AI should look for to explain WHY, in one sentence. */
  aiHint: string;
}

export const RULES: Readonly<Record<FindingId, Rule>> = {
  "relay-reservation-never-completed": {
    id: "relay-reservation-never-completed",
    title: "Relay reservation never completed",
    severity: "block",
    meaning:
      "The relay never confirmed this reservation. No peer can dial in through this relay circuit.",
    remedy: "Check the relay's health and the network path between the client and the relay.",
    aiHint: "Find nearby relay.dial events and check if the relay connection dropped first.",
  },
  "relay-unreachable": {
    id: "relay-unreachable",
    title: "Relay unreachable",
    severity: "block",
    meaning: "The client failed four relay dials in a row. The relay is unreachable from here.",
    remedy: "Check the relay address, DNS, and firewall rules on the client's network.",
    aiHint: "Read the fail reason in each relay.dial.fail event and compare it across attempts.",
  },
  "relay-flapping": {
    id: "relay-flapping",
    title: "Relay flapping",
    severity: "warn",
    meaning: "The relay connection dropped three times in five minutes. The link is unstable.",
    remedy: "Check the relay's load and the client's network stability.",
    aiHint: "Look at the relay.dial.attempt gaps around each disconnect for a pattern.",
  },
  "rendezvous-wedged": {
    id: "rendezvous-wedged",
    title: "Rendezvous wedged",
    severity: "block",
    meaning:
      "The rendezvous stream registered but never listed room peers, or the relay killed it on a liveness timeout.",
    remedy: "Restart the rendezvous stream and check the relay's liveness timer.",
    aiHint: "Compare this observer's rv.register time with the relay's rv.close reason.",
  },
  "turn-missing-and-needed": {
    id: "turn-missing-and-needed",
    title: "TURN missing and needed",
    severity: "block",
    meaning:
      "TURN is unavailable and a relayed peer never proved a direct stream. The call has no confirmed path.",
    remedy: "Configure a working TURN server and confirm its credentials.",
    aiHint: "Check the ice.turn.fail reason and the peer's ICE candidate types.",
  },
  "connected-not-proven": {
    id: "connected-not-proven",
    title: "Connected but not proven",
    severity: "block",
    meaning: "The peer connected but never proved a working stream in time. Writes to it will vanish.",
    remedy: "Check the stream confirm handshake and the peer's write path.",
    aiHint: "Look for stream.confirm.fail or stream.write.fail events for this peer right after connect.",
  },
  "asymmetric-link": {
    id: "asymmetric-link",
    title: "Asymmetric link",
    severity: "block",
    meaning:
      "One peer saw the other connect, but the reverse view is missing. The two sides disagree about this link.",
    remedy: "Check both peers' dial logs for the same time window.",
    aiHint: "Compare peer.dial and peer.connect events from both vantages for this pair.",
  },
  "upgrade-starved": {
    id: "upgrade-starved",
    title: "Upgrade starved",
    severity: "warn",
    meaning: "This peer failed three direct-upgrade attempts. The link stays relayed instead of direct.",
    remedy: "Check the NAT type and ICE candidate set for this peer.",
    aiHint: "Read each peer.upgrade.fail detail for a repeated failure reason.",
  },
  "liveness-flap": {
    id: "liveness-flap",
    title: "Liveness flap",
    severity: "warn",
    meaning: "This peer dropped on liveness three times in five minutes. The connection is unstable.",
    remedy: "Check the peer's network path and the liveness timer settings.",
    aiHint: "Look at peer.rtt values around each drop for a pattern.",
  },
  "stream-confirm-starved": {
    id: "stream-confirm-starved",
    title: "Stream confirm starved",
    severity: "block",
    meaning: "The stream confirm handshake failed twice for this peer. The stream cannot be trusted yet.",
    remedy: "Check the peer's stream open and confirm code path.",
    aiHint: "Read the confirm attempt count in each stream.confirm.fail event.",
  },
  "room-view-split": {
    id: "room-view-split",
    title: "Room view split",
    severity: "warn",
    meaning:
      "The rendezvous peer count and the gossiped room count disagree for over 30 seconds. Membership views split.",
    remedy: "Check the room sync path between rendezvous and the gossip layer.",
    aiHint: "Compare rv.peers and app.roomusers counts from the same observer at the same time.",
  },
  "message-rejected": {
    id: "message-rejected",
    title: "Message rejected",
    severity: "block",
    meaning: "A message failed verification and was rejected. Content did not reach the app.",
    remedy: "Check the sender's signing key and the message format for this reason.",
    aiHint: "Group rejections by reason and check which peer sent each one.",
  },
  "sync-stalled": {
    id: "sync-stalled",
    title: "Sync stalled",
    severity: "warn",
    meaning:
      "A digest went out but got no reply for over 60 seconds, while a peer was proven. Sync can be stuck.",
    remedy: "Check the peer's digest handler and its inbound stream.",
    aiHint: "Check if the peer sent app.digest.in at all, or only late.",
  },
  "voice-never-connected": {
    id: "voice-never-connected",
    title: "Voice never connected",
    severity: "block",
    meaning: "A voice peer connection never reached ICE connected in time. The call never started for this peer.",
    remedy: "Check ICE candidates, TURN, and the signaling path for this peer.",
    aiHint: "Look at voice.ice.state and voice.signal.invalid events for this peer.",
  },
  "voice-media-stalled": {
    id: "voice-media-stalled",
    title: "Voice media stalled",
    severity: "block",
    meaning: "Voice media stalled and never resumed. Audio stopped flowing to this peer.",
    remedy: "Check the peer's network path and the media pipeline for a stuck track.",
    aiHint: "Check the silent duration in the voice.media.stall detail.",
  },
  "voice-relayed-only": {
    id: "voice-relayed-only",
    title: "Voice relayed only",
    severity: "warn",
    meaning: "Every voice connection in this capture used a relay path. No direct voice path ever formed.",
    remedy: "Check TURN reachability and the NAT type for the peers in this call.",
    aiHint: "Check ice.turn.ok and the ICE candidate types across the capture.",
  },
  "voice-restart-loop": {
    id: "voice-restart-loop",
    title: "Voice restart loop",
    severity: "warn",
    meaning: "This voice peer restarted three or more times. The connection cannot hold steady.",
    remedy: "Check network stability and the ICE restart trigger for this peer.",
    aiHint: "Read the gap between each voice.restart to find the restart trigger.",
  },
  "sfu-session-latched": {
    id: "sfu-session-latched",
    title: "SFU session latched",
    severity: "block",
    meaning:
      "An operation ceiling killed the whole SFU session instead of just that operation. The client has no branch for this reason.",
    remedy: "Add a specific handler for this SFU error reason on the client.",
    aiHint: "Check the producer and consumer counts at the time of this error.",
  },
  "sfu-transport-timeout": {
    id: "sfu-transport-timeout",
    title: "SFU transport timeout",
    severity: "warn",
    meaning: "An SFU transport timed out in one direction. That send or receive path did not connect in time.",
    remedy: "Check the SFU host reachability and the ICE state for this direction.",
    aiHint: "Check sfu.transport.state events for this direction right before the timeout.",
  },
  "sfu-rejoin-loop": {
    id: "sfu-rejoin-loop",
    title: "SFU rejoin loop",
    severity: "block",
    meaning: "The client rejoined the SFU three or more times. The rejoin ladder has no attempt cap.",
    remedy: "Add a rejoin attempt limit and surface a hard failure after it.",
    aiHint: "Read the delay between each sfu.rejoin to find the retry pattern.",
  },
  "sfu-consumer-stalled": {
    id: "sfu-consumer-stalled",
    title: "SFU consumer stalled",
    severity: "warn",
    meaning: "A track stalled twice or more for one producer. The viewer is not getting media.",
    remedy: "Check the producer's bitrate and the consumer's network path.",
    aiHint: "Check sfu.transport.state around each stall for a shared cause.",
  },
  "sfu-room-split": {
    id: "sfu-room-split",
    title: "SFU room split",
    severity: "block",
    meaning:
      "The SFU room peer count and the voice call roster disagree for over 30 seconds. The two systems see different rooms.",
    remedy: "Check that every call participant joined both the voice mesh and the SFU room.",
    aiHint: "Compare sfu.diag roomPeers with voice.join and voice.leave counts for this observer.",
  },
  "sfu-placement-disagreement": {
    id: "sfu-placement-disagreement",
    title: "SFU placement disagreement",
    severity: "block",
    meaning: "Two client vantages picked different SFU hosts for this capture. Peers can end up in different video rooms.",
    remedy: "Check the SFU host selection logic and the pool configuration.",
    aiHint: "Compare each sfu.pick host against the configured SFU host pool.",
  },
  "clock-skew": {
    id: "clock-skew",
    title: "Clock skew",
    severity: "warn",
    meaning: "The clock offset solve left a residual over the acceptable limit. Cross-vantage timing here is not reliable.",
    remedy: "Check for missing or noisy peer.clock samples across vantages.",
    aiHint: "Check which vantage has the fewest peer.clock samples.",
  },
  "fault-injection-active": {
    id: "fault-injection-active",
    title: "Fault injection active",
    severity: "warn",
    meaning: "A fault was active during this capture. Every other finding here can be a fault artifact, not a real bug.",
    remedy: "Re-run the capture with faults off to confirm the finding still holds.",
    aiHint: "Check which fault flags were set and match them to the failing behavior.",
  },
  "unconfigured-instance": {
    id: "unconfigured-instance",
    title: "Unconfigured instance",
    severity: "block",
    meaning: "This build was never configured with a relay or SFU host. Nothing in this session could work.",
    remedy: "Set the runtime configuration before this instance connects.",
    aiHint: "Check the config detail for a missing apiHost, relayPeerId, or sfuHosts.",
  },
  "storage-locked-writes": {
    id: "storage-locked-writes",
    title: "Storage locked writes",
    severity: "warn",
    meaning: "Storage was locked when a write was due. The offline DM queue did not persist that write.",
    remedy: "Check when the vault unlocks relative to this write attempt.",
    aiHint: "Check the time gap between session.unlock and this storage.locked event.",
  },
  "capture-incomplete": {
    id: "capture-incomplete",
    title: "Capture incomplete",
    severity: "info",
    meaning: "Some events were dropped or throttled before capture. Findings before the first surviving event can be wrong.",
    remedy: "Raise the ring capacity or the throttle budget for the noisy kind.",
    aiHint: "Check the suppressed kind counts to find which signal was lost.",
  },
  "turn-unreachable": {
    id: "turn-unreachable",
    title: "TURN unreachable from this network",
    severity: "block",
    meaning:
      "The client held valid TURN credentials and the server still gave it no allocation. This peer has no relayed path, and the cause is outside the app.",
    remedy:
      "Check that the TURN host is reachable on its UDP and TCP ports from this network, and that coturn is running.",
    aiHint:
      "Compare this against the app's own ICE results. A failed probe explains a failed connection. A probe that passed next to a connection that failed points at the app instead.",
  },
  "producer-never-consumed": {
    id: "producer-never-consumed",
    title: "Producer never consumed",
    severity: "block",
    meaning:
      "The SFU announced a camera producer to this peer. No consumer was ever built for it, so the tile stayed empty while everything reported connected.",
    remedy:
      "Check whether the receive transport still accepts a consume. One rejected consume can leave it unable to accept any later one.",
    aiHint:
      "Find the sfu.consume announced event, then read every sfu.consume.failed and sfu.transport.state for the same vantage after it.",
  },
  "peerconnection-leak": {
    id: "peerconnection-leak",
    title: "PeerConnection leak",
    severity: "block",
    meaning:
      "This tab held too many RTCPeerConnections at once. The browser refuses new connections at 500, and then voice, the SFU and libp2p all fail together.",
    remedy:
      "Find the loop that builds connections and does not close them. Compare pcCreated against pcLive over time.",
    aiHint:
      "Read pcLive across the runtime.resources samples. A count that only climbs is a leak. A pcCreated that climbs while pcLive holds is a rebuild loop.",
  },
  "uncaught-error": {
    id: "uncaught-error",
    title: "Uncaught error",
    severity: "warn",
    meaning: "An exception reached the window. No code in the app caught it.",
    remedy: "Add a handler at the throw site, or fix the condition that throws.",
    aiHint:
      "Read the err text and the events immediately before it in the same vantage.",
  },
  "relay-close-unclean": {
    id: "relay-close-unclean",
    title: "Relay close unclean",
    severity: "warn",
    meaning: "The relay closed this stream for a reason other than a graceful close.",
    remedy: "Check the named close reason against the relay's timeout and cap settings.",
    aiHint: "Match the close reason to the relay's idle, liveness, or cap constants.",
  },
} as const satisfies Record<FindingId, Rule>;
