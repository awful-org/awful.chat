package main

// Per-address circuit-relay reservation limits that know about proxies.
//
// A reservation is how a browser becomes dialable at all - it cannot
// listen - and there are MaxReservations (connMgrHigh) of them for the
// whole relay. go-libp2p's own per-IP and per-ASN reservation caps cannot
// tell a proxy from a client, so relayResources has to lift them to the
// global ceiling: behind Traefik every browser shares one address, and a
// per-IP cap there is a cap on the whole service. Lifted, though, nothing
// stopped about 512 free peerIds from one host holding every reservation,
// leaving every new browser undialable.
//
// reservationGate is the per-address cap that can tell the two apart. It
// applies to connections from a public address - the relay really is
// seeing a client - and waves through a proxy-class one (isProxyClassAddr),
// where the global ceiling stays the only bound. It is a relayv2 ACL, so it
// runs before the relay's own accounting and never touches circuits:
// AllowConnect always says yes, for the reasons in the note on the circuit
// ACL in main.go.

import (
	"net/netip"
	"slices"
	"sync"
	"time"

	"github.com/libp2p/go-libp2p/core/peer"
	ma "github.com/multiformats/go-multiaddr"
	manet "github.com/multiformats/go-multiaddr/net"
)

const (
	// Reservations one public address (an IPv4 address or IPv6 /64) may hold
	// at once. A reservation is one per peerId, and a person's browser holds
	// one or two (a second libp2p node while device sync runs), so 32 is a
	// household or small office behind one NAT, and one address can take at
	// most 1/16 of the relay's reservations instead of all of them.
	maxReservationsPerAddr = 32
	// Reservations one IPv6 /48 may hold across all its /64s.
	maxReservationsPerAggregate = maxReservationsPerAddr * ipv6AggregateFactor
)

type gateEntry struct {
	keys    []string
	expires time.Time
}

type reservationGate struct {
	mu     sync.Mutex
	ttl    time.Duration
	byPeer map[peer.ID]gateEntry
	counts map[string]int
	now    func() time.Time
}

// newReservationGate tracks reservations for ttl after each grant or
// refresh - the relay's own ReservationTTL, so an entry lapses exactly when
// the reservation it stands for would - and until the peer disconnects,
// which is when the relay drops the reservation itself.
func newReservationGate(ttl time.Duration) *reservationGate {
	return &reservationGate{
		ttl:    ttl,
		byPeer: map[peer.ID]gateEntry{},
		counts: map[string]int{},
		now:    time.Now,
	}
}

// AllowReserve admits a reservation, or its refresh, if the address it came
// from is under its share. A refused peer gets RESERVATION_REFUSED from the
// relay, the answer it already handles for a full relay.
func (g *reservationGate) AllowReserve(p peer.ID, a ma.Multiaddr) bool {
	ip, err := manet.ToIP(a)
	if err != nil {
		// No address to budget; the relay's own constraints refuse these.
		return true
	}
	addr, _ := netip.AddrFromSlice(ip)
	addr = addr.Unmap()

	g.mu.Lock()
	defer g.mu.Unlock()
	now := g.now()
	g.expireLocked(now)

	if isProxyClassAddr(addr) {
		// The peer may have moved from a public address to the proxy; it
		// holds nothing against that address any more.
		g.dropLocked(p)
		return true
	}
	own, agg := clientBuckets(addr.String())
	keys := []string{own}
	limits := []int{maxReservationsPerAddr}
	if agg != "" {
		keys = append(keys, agg)
		limits = append(limits, maxReservationsPerAggregate)
	}

	if e, ok := g.byPeer[p]; ok {
		if slices.Equal(e.keys, keys) {
			// A refresh of a reservation this address already holds.
			e.expires = now.Add(g.ttl)
			g.byPeer[p] = e
			return true
		}
		g.dropLocked(p)
	}
	for i, k := range keys {
		if g.counts[k] >= limits[i] {
			return false
		}
	}
	for _, k := range keys {
		g.counts[k]++
	}
	g.byPeer[p] = gateEntry{keys: keys, expires: now.Add(g.ttl)}
	return true
}

// AllowConnect never refuses: see the note on the circuit ACL in main.go.
func (g *reservationGate) AllowConnect(peer.ID, ma.Multiaddr, peer.ID) bool {
	return true
}

// forget releases a peer's reservation once it has no connection left,
// which is when the relay drops the reservation too.
func (g *reservationGate) forget(p peer.ID) {
	g.mu.Lock()
	defer g.mu.Unlock()
	g.dropLocked(p)
}

func (g *reservationGate) dropLocked(p peer.ID) {
	e, ok := g.byPeer[p]
	if !ok {
		return
	}
	delete(g.byPeer, p)
	for _, k := range e.keys {
		if g.counts[k]--; g.counts[k] <= 0 {
			delete(g.counts, k)
		}
	}
}

// expireLocked drops entries whose reservation has lapsed without a
// refresh. The map is bounded by connected peers, so a walk per request is
// cheap.
func (g *reservationGate) expireLocked(now time.Time) {
	for p, e := range g.byPeer {
		if now.After(e.expires) {
			g.dropLocked(p)
		}
	}
}
