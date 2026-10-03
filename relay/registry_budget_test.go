package main

import (
	"fmt"
	"net/netip"
	"testing"
)

func newClientFrom(r *registry, peerId, addr string) *connectedClient {
	c := r.addStreamFrom(peerId, &fakeStream{}, netip.MustParseAddr(addr))
	if c == nil {
		panic("registry refused a stream for " + peerId)
	}
	return c
}

func registered(r *registry, c *connectedClient) int {
	r.mu.Lock()
	defer r.mu.Unlock()
	return len(c.rooms)
}

// The exhaustion attack: a few seed peers open junk rooms, then free
// peerIds from ONE host join those populated rooms - which used to cost
// nothing - until the whole registry is full. Those identities now share
// their host's budget, and that budget is a small slice of the registry.
func TestFreePeerIdsFromOneHostShareOneBudget(t *testing.T) {
	r := newRegistry()
	const host = "198.51.100.7"
	seed := newClientFrom(r, "seed", host)
	liftEmptyRegisterBudget(r, "seed")
	r.mu.Lock()
	r.sources[host].empty.limit = 1 << 30
	r.mu.Unlock()
	const rooms = 256
	for i := range rooms {
		r.register(seed, fmt.Sprintf("junk-%d", i))
	}

	held := registered(r, seed)
	for p := 0; p < maxRoomsPerSource; p++ {
		c := newClientFrom(r, fmt.Sprintf("sybil-%d", p), host)
		for i := range rooms {
			if r.register(c, fmt.Sprintf("junk-%d", i)) != registerJoined {
				break
			}
		}
		n := registered(r, c)
		held += n
		if n < rooms {
			break
		}
	}
	if held != maxRoomsPerSource {
		t.Fatalf("one host holds %d registrations, its share is %d", held, maxRoomsPerSource)
	}

	// Somebody else, on another network, is unaffected.
	other := newClientFrom(r, "neighbour", "203.0.113.5")
	if got := r.register(other, "junk-0"); got != registerJoined {
		t.Fatalf("an unrelated host was refused: %v", got)
	}
}

// Behind a proxy every browser comes from the proxy's address. The
// per-source budgets must not turn that address into a ceiling on the
// whole service.
func TestProxyClassConnectionsAreNotOneSource(t *testing.T) {
	r := newRegistry()
	for p := 0; p < 10; p++ {
		c := newClientFrom(r, fmt.Sprintf("user-%d", p), "10.0.1.5")
		if c.source != "" || c.sourceAgg != "" {
			t.Fatalf("a proxy-class connection got source buckets %q %q", c.source, c.sourceAgg)
		}
	}
	r.mu.Lock()
	n := len(r.sources)
	r.mu.Unlock()
	if n != 0 {
		t.Fatalf("proxy-class streams created %d source buckets", n)
	}
	// And an IPv6 client gets its /64 and its /48.
	c := newClientFrom(r, "v6", "2001:db8:1:2::9")
	if c.source != "2001:db8:1:2::/64" || c.sourceAgg != "2001:db8:1::/48" {
		t.Fatalf("IPv6 buckets: %q %q", c.source, c.sourceAgg)
	}
}

// Filling the registry used to lock every newcomer out. Past the soft
// ceiling a peer still gets its guaranteed rooms - enough for its own
// conversations - and no more.
func TestSoftCeilingStillAdmitsAPeersFirstRooms(t *testing.T) {
	r := newRegistry()
	a, _ := newClient(r, "late-peer")
	liftEmptyRegisterBudget(r, "late-peer")
	r.mu.Lock()
	r.total = maxTotalRegistrations
	r.mu.Unlock()
	for i := range guaranteedRoomsPerPeer {
		if got := r.register(a, fmt.Sprintf("mine-%d", i)); got != registerJoined {
			t.Fatalf("room %d of the guaranteed %d refused at the ceiling: %v", i, guaranteedRoomsPerPeer, got)
		}
	}
	if got := r.register(a, "one-more"); got != registerCapped {
		t.Fatalf("a room past the guarantee at the ceiling returned %v, want registerCapped", got)
	}
}

// A room holds at most maxPeersPerRoom distinct peers. Another tab of a
// peer already inside is not a new peer and still gets in.
func TestRoomPeerCap(t *testing.T) {
	r := newRegistry()
	first, _ := newClient(r, "peer-0")
	r.register(first, "big")
	for p := 1; p < maxPeersPerRoom; p++ {
		c, _ := newClient(r, fmt.Sprintf("peer-%d", p))
		if got := r.register(c, "big"); got != registerJoined {
			t.Fatalf("peer %d refused below the cap: %v", p, got)
		}
	}
	late, _ := newClient(r, "late")
	if got := r.register(late, "big"); got != registerCapped {
		t.Fatalf("peer past the room cap got %v, want registerCapped", got)
	}
	secondTab, _ := newClient(r, "peer-0")
	if got := r.register(secondTab, "big"); got != registerJoined {
		t.Fatalf("a member's second tab was refused: %v", got)
	}
}

// Joining a populated room is charged too - more cheaply than an empty one,
// and never so dearly that a reconnect burst (every saved room, then the DM
// lobbies 70 s later) stops fitting in one window.
func TestPopulatedJoinsAreChargedButAReconnectFits(t *testing.T) {
	r := newRegistry()
	friend, _ := newClient(r, "friend")
	liftEmptyRegisterBudget(r, "friend")
	rooms := maxRoomsPerPeer - 64
	for i := range rooms {
		r.register(friend, fmt.Sprintf("room-%d", i))
	}

	a, _ := newClient(r, "returning")
	for i := range rooms {
		if got := r.register(a, fmt.Sprintf("room-%d", i)); got != registerJoined {
			t.Fatalf("reconnect burst refused at room %d: %v", i, got)
		}
	}
	// The lobbies: usually empty, so they also spend the empty-room budget.
	for i := range 64 {
		if got := r.register(a, fmt.Sprintf("dm-lobby-%d", i)); got != registerJoined {
			t.Fatalf("lobby %d refused: %v", i, got)
		}
	}

	// Churning populated rooms is what the budget exists for: leave and
	// rejoin until the window runs out.
	r.mu.Lock()
	left := r.joins["returning"].left
	r.mu.Unlock()
	refused := false
	for i := 0; i <= left+1; i++ {
		r.unregister(a, "room-0")
		if r.register(a, "room-0") == registerCapped {
			refused = true
			break
		}
	}
	if !refused {
		t.Fatal("populated-room churn was never charged")
	}
}
