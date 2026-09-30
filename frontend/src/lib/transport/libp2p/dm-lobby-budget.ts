/**
 * How many DM-lobby introductions this device may start.
 *
 * The relay decides who is listed in a lobby (see LibP2PTransport's DM
 * lobbies), and every listed peer we act on costs a dial and an introduction.
 * A lobby is there for one person, whose devices are few, so an honest lobby
 * never needs more than a handful; a hostile relay listing thousands of made-up
 * peers must get no more than that handful out of us. Three limits, all
 * needed:
 *
 *   per peer    one try per retry window, as before;
 *   per lobby   a few distinct peers per retry window - what one person's
 *               devices can plausibly be;
 *   overall     a small number a minute across every lobby, so many lobbies
 *               cannot add up to a flood either.
 *
 * Memory stays bounded by dropping the OLDEST peer entries past a cap. The
 * old rule forgot everyone once its table filled, which let a relay that
 * rotated through fresh ids start the whole cycle again.
 */

export interface LobbyDialLimits {
  retryMs: number;
  perLobby: number;
  perMinute: number;
  maxPeers: number;
}

export const DEFAULT_LOBBY_DIAL_LIMITS: LobbyDialLimits = {
  retryMs: 10 * 60_000,
  perLobby: 4,
  perMinute: 16,
  maxPeers: 1024,
};

const MINUTE_MS = 60_000;

export class LobbyDialBudget {
  /** peer -> when we last started an introduction with them; oldest first. */
  #peers = new Map<string, number>();
  /** lobby -> when each introduction for it started, within the window. */
  #lobbies = new Map<string, number[]>();
  /** Every introduction started in the last minute. */
  #recent: number[] = [];

  constructor(private readonly limits: LobbyDialLimits = DEFAULT_LOBBY_DIAL_LIMITS) {}

  /** Cheap pre-check: could this peer be tried at all right now? */
  mayTry(peer: string, now: number = Date.now()): boolean {
    const last = this.#peers.get(peer);
    return last === undefined || now - last >= this.limits.retryMs;
  }

  /** Spend one introduction on this peer in this lobby, if every limit allows. */
  allow(lobby: string, peer: string, now: number = Date.now()): boolean {
    if (!this.mayTry(peer, now)) return false;
    const inLobby = (this.#lobbies.get(lobby) ?? []).filter((t) => now - t < this.limits.retryMs);
    this.#lobbies.set(lobby, inLobby);
    if (inLobby.length >= this.limits.perLobby) return false;
    this.#recent = this.#recent.filter((t) => now - t < MINUTE_MS);
    if (this.#recent.length >= this.limits.perMinute) return false;
    inLobby.push(now);
    this.#recent.push(now);
    this.#peers.delete(peer);
    this.#peers.set(peer, now);
    while (this.#peers.size > this.limits.maxPeers) {
      this.#peers.delete(this.#peers.keys().next().value as string);
    }
    return true;
  }

  /** A lobby that was released: its history goes with it. */
  forgetLobby(lobby: string): void {
    this.#lobbies.delete(lobby);
  }

  clear(): void {
    this.#peers.clear();
    this.#lobbies.clear();
    this.#recent = [];
  }
}
