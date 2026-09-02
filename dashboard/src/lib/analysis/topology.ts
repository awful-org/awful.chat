/**
 * The topology graph, folded from the merged timeline.
 *
 * Every link is DIRECTED on purpose. The whole reason three vantages exist is
 * that A's view and B's view disagree: "A sees B, B never saw A" is a real
 * failure this codebase produces, and an undirected edge hides it.
 *
 * `applyEvent` is an EXHAUSTIVE switch over `DiagKind`. A kind added to the
 * schema without a decision here is a compile error, which is the only way to
 * keep the fold honest as the vocabulary grows.
 */

import {
  LOG_RAW_KIND,
  type Capture,
  type MergedEvent,
  type MergedKind,
  type VantageKind,
} from "./merge";

/**
 * Copied, not imported, from `frontend/src/lib/peer-online-status.ts`. That
 * module exists because the transport's connected set says nothing about
 * whether a frame can reach the peer, and reporting "online" from
 * `peer.connect` alone reproduces the exact bug it was written to fix.
 */
export const PEER_PROOF_GRACE_MS = 3000;

export type LinkState =
  | "none"
  | "dialing"
  | "dial-failed"
  | "relayed"
  | "direct"
  | "proven"
  | "lost"
  | "dropped";

export type VoiceLinkState =
  | "none"
  | "new"
  | "connected"
  | "relayed"
  | "degraded"
  | "stalled"
  | "failed"
  | "torn-down";

export type MediaLinkState = "none" | "flowing" | "stalled";

export interface TopologyNode {
  peerId: string;
  identityRef: string | null;
  /** Room refs, scoped `source:ref` - see `RoomSummary`. */
  rooms: string[];
  online: boolean;
  connecting: boolean;
}

export interface TopologyLink {
  from: string;
  to: string;
  state: LinkState;
  voice: VoiceLinkState;
  media: MediaLinkState;
  /** When `state` last changed, so the grace window can be applied. */
  changedAt: number;
  /** When this observer first saw the peer connected, for the grace window. */
  connectedSince: number | null;
  proven: boolean;
}

export interface TopologyRelay {
  peerId: string;
  connected: boolean;
  reserved: boolean;
}

export interface TopologySfu {
  host: string;
  connected: boolean;
  roomPeerCount: number | null;
}

export interface Topology {
  at: number;
  /** The primary client vantage's peerId. */
  self: string;
  relay: TopologyRelay | null;
  sfu: TopologySfu | null;
  nodes: TopologyNode[];
  /** Directed: what `from` believed about `to` at `at`. */
  links: TopologyLink[];
}

interface LinkKey {
  from: string;
  to: string;
}

interface FoldState {
  /** Per observer. */
  relay: Map<string, TopologyRelay>;
  sfu: Map<string, TopologySfu>;
  /** Keyed `observer|peer`. */
  links: Map<string, TopologyLink>;
  /** Room refs per peer. */
  rooms: Map<string, Set<string>>;
  identity: Map<string, string | null>;
}

function emptyState(): FoldState {
  return {
    relay: new Map(),
    sfu: new Map(),
    links: new Map(),
    rooms: new Map(),
    identity: new Map(),
  };
}

function linkOf(state: FoldState, key: LinkKey, at: number): TopologyLink {
  const id = `${key.from}|${key.to}`;
  const hit = state.links.get(id);
  if (hit) return hit;
  const fresh: TopologyLink = {
    from: key.from,
    to: key.to,
    state: "none",
    voice: "none",
    media: "none",
    changedAt: at,
    connectedSince: null,
    proven: false,
  };
  state.links.set(id, fresh);
  return fresh;
}

function relayOf(state: FoldState, observer: string): TopologyRelay {
  const hit = state.relay.get(observer);
  if (hit) return hit;
  const fresh: TopologyRelay = { peerId: "", connected: false, reserved: false };
  state.relay.set(observer, fresh);
  return fresh;
}

function sfuOf(state: FoldState, observer: string): TopologySfu {
  const hit = state.sfu.get(observer);
  if (hit) return hit;
  const fresh: TopologySfu = { host: "", connected: false, roomPeerCount: null };
  state.sfu.set(observer, fresh);
  return fresh;
}

function setLinkState(link: TopologyLink, next: LinkState, at: number): boolean {
  if (link.state === next) return false;
  link.state = next;
  link.changedAt = at;
  return true;
}

function noteRoom(state: FoldState, peer: string, room: string): boolean {
  let set = state.rooms.get(peer);
  if (!set) {
    set = new Set();
    state.rooms.set(peer, set);
  }
  if (set.has(room)) return false;
  set.add(room);
  return true;
}

/**
 * Apply one event. Returns true when it changed the graph, which is what makes
 * `topologyKeyframes` cheap and exact.
 */
function applyEvent(state: FoldState, e: MergedEvent): boolean {
  const observer = e.observer;
  const peer = e.peer;
  const kind: MergedKind = e.kind;

  switch (kind) {
    // ----- relay, per observer -----
    case "relay.dial.ok": {
      const relay = relayOf(state, observer);
      const was = relay.connected;
      relay.connected = true;
      return !was;
    }
    case "relay.disconnect":
    case "relay.dial.fail": {
      const relay = relayOf(state, observer);
      const was = relay.connected || relay.reserved;
      relay.connected = false;
      relay.reserved = false;
      return was;
    }
    case "relay.reservation.ok": {
      const relay = relayOf(state, observer);
      const was = relay.reserved;
      relay.reserved = true;
      return !was;
    }
    case "relay.reservation.timeout": {
      const relay = relayOf(state, observer);
      const was = relay.reserved;
      relay.reserved = false;
      return was;
    }

    // ----- the direct peer link -----
    case "peer.dial.start":
      if (!peer) return false;
      return setLinkState(linkOf(state, { from: observer, to: peer }, e.at), "dialing", e.at);
    case "peer.dial.fail":
    case "stream.open.fail":
    case "stream.confirm.fail":
      if (!peer) return false;
      return setLinkState(linkOf(state, { from: observer, to: peer }, e.at), "dial-failed", e.at);
    case "peer.dial.ok":
    case "peer.redial":
      if (!peer) return false;
      return setLinkState(linkOf(state, { from: observer, to: peer }, e.at), "dialing", e.at);
    case "peer.connect": {
      if (!peer) return false;
      const link = linkOf(state, { from: observer, to: peer }, e.at);
      const changed = setLinkState(link, link.proven ? "proven" : "relayed", e.at);
      if (link.connectedSince === null) {
        link.connectedSince = e.at;
        return true;
      }
      return changed;
    }
    case "peer.disconnect": {
      if (!peer) return false;
      const link = linkOf(state, { from: observer, to: peer }, e.at);
      link.proven = false;
      link.connectedSince = null;
      return setLinkState(link, "lost", e.at);
    }
    case "peer.drop.liveness": {
      if (!peer) return false;
      const link = linkOf(state, { from: observer, to: peer }, e.at);
      link.proven = false;
      link.connectedSince = null;
      return setLinkState(link, "dropped", e.at);
    }
    case "peer.relayed":
      if (!peer) return false;
      return setLinkState(linkOf(state, { from: observer, to: peer }, e.at), "relayed", e.at);
    case "peer.direct": {
      if (!peer) return false;
      const link = linkOf(state, { from: observer, to: peer }, e.at);
      return setLinkState(link, link.proven ? "proven" : "direct", e.at);
    }
    case "stream.proven": {
      if (!peer) return false;
      const link = linkOf(state, { from: observer, to: peer }, e.at);
      const was = link.proven;
      link.proven = true;
      if (link.connectedSince === null) link.connectedSince = e.at;
      return setLinkState(link, "proven", e.at) || !was;
    }
    case "stream.lost": {
      if (!peer) return false;
      const link = linkOf(state, { from: observer, to: peer }, e.at);
      const was = link.proven;
      link.proven = false;
      return setLinkState(link, "lost", e.at) || was;
    }

    // ----- voice -----
    case "voice.join":
    case "voice.pc.new": {
      if (!peer) return false;
      const link = linkOf(state, { from: observer, to: peer }, e.at);
      const next: VoiceLinkState = e.sev === "error" ? "failed" : "new";
      if (link.voice === next) return false;
      link.voice = next;
      return true;
    }
    case "voice.ice.connected": {
      if (!peer) return false;
      const link = linkOf(state, { from: observer, to: peer }, e.at);
      const next: VoiceLinkState = e.d?.relayed === true ? "relayed" : "connected";
      if (link.voice === next) return false;
      link.voice = next;
      return true;
    }
    case "voice.degraded":
      return setVoice(state, observer, peer, "degraded", e.at);
    case "voice.failed":
      return setVoice(state, observer, peer, "failed", e.at);
    case "voice.leave":
    case "voice.teardown":
      return setVoice(state, observer, peer, "torn-down", e.at);
    case "voice.restart":
      return setVoice(state, observer, peer, "new", e.at);
    case "voice.media.stall": {
      if (!peer) return false;
      const link = linkOf(state, { from: observer, to: peer }, e.at);
      if (link.media === "stalled" && link.voice === "stalled") return false;
      link.media = "stalled";
      link.voice = "stalled";
      return true;
    }
    case "voice.media.resume": {
      if (!peer) return false;
      const link = linkOf(state, { from: observer, to: peer }, e.at);
      if (link.media === "flowing") return false;
      link.media = "flowing";
      return true;
    }

    // ----- sfu -----
    case "sfu.pick": {
      const sfu = sfuOf(state, observer);
      const host = typeof e.d?.host === "string" ? e.d.host : "";
      if (sfu.host === host) return false;
      sfu.host = host;
      return true;
    }
    case "sfu.ws.open": {
      const sfu = sfuOf(state, observer);
      if (sfu.connected) return false;
      sfu.connected = true;
      return true;
    }
    case "sfu.ws.close": {
      const sfu = sfuOf(state, observer);
      if (!sfu.connected) return false;
      sfu.connected = false;
      sfu.roomPeerCount = null;
      return true;
    }
    case "sfu.diag": {
      const sfu = sfuOf(state, observer);
      const count = typeof e.d?.roomPeers === "number" ? e.d.roomPeers : null;
      if (sfu.roomPeerCount === count) return false;
      sfu.roomPeerCount = count;
      return true;
    }
    case "sfu.track.added": {
      if (!peer) return false;
      const link = linkOf(state, { from: observer, to: peer }, e.at);
      if (link.media === "flowing") return false;
      link.media = "flowing";
      return true;
    }
    case "sfu.track.stalled": {
      if (!peer) return false;
      const link = linkOf(state, { from: observer, to: peer }, e.at);
      if (link.media === "stalled") return false;
      link.media = "stalled";
      return true;
    }

    // ----- room membership -----
    case "rv.peers":
    case "app.join":
    case "app.leave": {
      if (!e.room) return false;
      const subject = peer ?? observer;
      return noteRoom(state, subject, `${e.source}:${e.room}`);
    }

    // ----- kinds that carry no topology, listed so the switch stays total -----
    case "session.start":
    case "session.config":
    case "session.unlock":
    case "session.visibility":
    case "session.online":
    case "session.end":
    case "relay.dial.attempt":
    case "relay.reservation.request":
    case "relay.reconnect.schedule":
    case "relay.reconnect.fail":
    case "rv.open":
    case "rv.open.fail":
    case "rv.register":
    case "rv.unregister":
    case "rv.peer.joined":
    case "rv.peer.left":
    case "rv.send.fail":
    case "rv.frame.oversize":
    case "rv.close":
    case "peer.upgrade.attempt":
    case "peer.upgrade.ok":
    case "peer.upgrade.fail":
    case "peer.rtt":
    case "peer.clock":
    case "stream.open":
    case "stream.reset":
    case "stream.write.fail":
    case "app.roomusers":
    case "app.msg.in":
    case "app.msg.out":
    case "app.msg.reject":
    case "app.profile.in":
    case "app.profile.reject":
    case "app.digest.out":
    case "app.digest.in":
    case "app.sync.drop":
    case "dm.send":
    case "dm.queue":
    case "dm.flush":
    case "dm.mailbox.deposit":
    case "dm.mailbox.collect":
    case "dm.mailbox.drop":
    case "ice.turn.ok":
    case "ice.turn.unavailable":
    case "ice.turn.fail":
    case "ice.servers.changed":
    case "voice.offer.out":
    case "voice.offer.in":
    case "voice.answer.in":
    case "voice.signal.invalid":
    case "voice.ice.state":
    case "voice.pc.state":
    case "voice.redial.ask":
    case "voice.redial.serve":
    case "sfu.ws.error":
    case "sfu.join":
    case "sfu.caps":
    case "sfu.transport.create":
    case "sfu.transport.state":
    case "sfu.transport.timeout":
    case "sfu.produce":
    case "sfu.consume":
    case "sfu.consume.failed":
    case "sfu.error":
    case "sfu.rejoin":
    case "file.announce":
    case "file.request":
    case "file.progress":
    case "file.fail":
    case "storage.locked":
    case "storage.quota":
    case "storage.drop":
    case "counters":
    case "fault.injected":
    case "meta.suppressed":
    // Local to one tab: an uncaught throw, the connection gauge and a media
    // sample say nothing about who can reach whom.
    // A placement fault is about which SERVER this tab reached, not about who
    // can reach whom, so the graph is unchanged by it.
    case "sfu.misplaced":
    case "voice.media.sample":
    case "runtime.error":
    case "runtime.resources":
    // A log line that no template matched. It carries no structure to fold,
    // but it is listed so the switch stays total over `MergedKind`.
    case LOG_RAW_KIND:
      return false;
  }
}

function setVoice(
  state: FoldState,
  observer: string,
  peer: string | null,
  next: VoiceLinkState,
  at: number
): boolean {
  if (!peer) return false;
  const link = linkOf(state, { from: observer, to: peer }, at);
  if (link.voice === next) return false;
  link.voice = next;
  return true;
}

/** The client vantage with the most events. It drives `self` and `online`. */
export function primaryObserver(c: Capture): string {
  const counts = new Map<string, number>();
  for (const v of c.vantages) {
    if (v.kind !== "client") continue;
    counts.set(v.observer, (counts.get(v.observer) ?? 0) + v.events.length);
  }
  let best = "";
  let most = -1;
  for (const [observer, n] of counts) {
    if (n > most) {
      most = n;
      best = observer;
    }
  }
  return best;
}

/**
 * Derive the display state of a peer from the primary observer's point of view.
 *
 * Connected AND proven is online. Connected without proof is online only inside
 * the grace window, because the ordinary handshake is briefly unproven and a
 * flicker to "connecting" on every normal join is worse than useless.
 */
function deriveOnline(
  link: TopologyLink | undefined,
  at: number
): { online: boolean; connecting: boolean } {
  if (!link) return { online: false, connecting: false };
  const connected =
    link.state === "relayed" ||
    link.state === "direct" ||
    link.state === "proven";
  if (!connected) return { online: false, connecting: false };
  if (link.proven) return { online: true, connecting: false };
  const withinGrace =
    link.connectedSince !== null && at - link.connectedSince < PEER_PROOF_GRACE_MS;
  return { online: withinGrace, connecting: !withinGrace };
}

function buildTopology(c: Capture, state: FoldState, at: number): Topology {
  const self = primaryObserver(c);
  const links = [...state.links.values()].map((l) => ({ ...l }));
  const selfLinks = new Map<string, TopologyLink>();
  for (const l of links) {
    if (l.from === self) selfLinks.set(l.to, l);
  }

  const nodes: TopologyNode[] = [];
  for (const [peerId, summary] of c.peers) {
    if (peerId === self) continue;
    const { online, connecting } = deriveOnline(selfLinks.get(peerId), at);
    nodes.push({
      peerId,
      identityRef: summary.identityRefs[0] ?? null,
      rooms: [...(state.rooms.get(peerId) ?? [])],
      online,
      connecting,
    });
  }
  nodes.sort((a, b) => a.peerId.localeCompare(b.peerId));

  const relay = state.relay.get(self) ?? null;
  if (relay) {
    const named = c.vantages.find((v) => v.kind === "client" && v.observer === self);
    relay.peerId = named?.bundle?.config.relayPeerId ?? relay.peerId;
  }

  return {
    at,
    self,
    relay: relay ? { ...relay } : null,
    sfu: state.sfu.get(self) ? { ...(state.sfu.get(self) as TopologySfu) } : null,
    nodes,
    links,
  };
}

/** The graph as of `at`. Events later than `at` are ignored. */
export function foldTopology(c: Capture, at: number): Topology {
  const state = emptyState();
  for (const e of c.timeline) {
    if (e.at > at) break;
    applyEvent(state, e);
  }
  return buildTopology(c, state, at);
}

/** Times where the graph actually changed. Always includes the window edges. */
export function topologyKeyframes(c: Capture): number[] {
  const state = emptyState();
  const out: number[] = [c.window.from];
  for (const e of c.timeline) {
    if (applyEvent(state, e) && out[out.length - 1] !== e.at) out.push(e.at);
  }
  if (out[out.length - 1] !== c.window.to) out.push(c.window.to);
  return out;
}

/** The vantage kinds present, for the Sessions view. */
export function vantageKinds(c: Capture): VantageKind[] {
  return [...new Set(c.vantages.map((v) => v.kind))];
}
