package main

import (
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p/core/crypto"
	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	rcmgr "github.com/libp2p/go-libp2p/p2p/host/resource-manager"
	circuitproto "github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/proto"
	relayv2 "github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/relay"
	"github.com/multiformats/go-multiaddr"
)

func testPeerID(t *testing.T) peer.ID {
	t.Helper()
	_, pub, err := crypto.GenerateEd25519Key(nil)
	if err != nil {
		t.Fatal(err)
	}
	id, err := peer.IDFromPublicKey(pub)
	if err != nil {
		t.Fatal(err)
	}
	return id
}

func wsAddr(t *testing.T, ip string) multiaddr.Multiaddr {
	t.Helper()
	proto := "ip4"
	if strings.Contains(ip, ":") {
		proto = "ip6"
	}
	a, err := multiaddr.NewMultiaddr(fmt.Sprintf("/%s/%s/tcp/40000/ws", proto, ip))
	if err != nil {
		t.Fatal(err)
	}
	return a
}

// The attack: ~512 free peerIds from one host held every reservation on the
// relay, and every new browser was undialable. One public address now holds
// its share and no more; a refresh is not a new reservation; a peer that
// disconnects gives its slot back.
func TestReservationGateCapsOnePublicAddress(t *testing.T) {
	g := newReservationGate(time.Hour)
	host := wsAddr(t, "198.51.100.20")
	var held []peer.ID
	for i := 0; i < maxReservationsPerAddr; i++ {
		p := testPeerID(t)
		if !g.AllowReserve(p, host) {
			t.Fatalf("reservation %d refused inside the share", i)
		}
		held = append(held, p)
	}
	if g.AllowReserve(testPeerID(t), host) {
		t.Fatal("one address got more than its share of reservations")
	}
	if !g.AllowReserve(held[0], host) {
		t.Fatal("a refresh of a held reservation was refused")
	}
	if !g.AllowReserve(testPeerID(t), wsAddr(t, "198.51.100.21")) {
		t.Fatal("another address was refused")
	}
	g.forget(held[1])
	if !g.AllowReserve(testPeerID(t), host) {
		t.Fatal("a disconnected peer's slot did not come back")
	}
}

// Behind Traefik every browser has the proxy's address. The gate must never
// be a cap on that address, or it is a cap on the whole service.
func TestReservationGateLetsProxiesThrough(t *testing.T) {
	g := newReservationGate(time.Hour)
	for _, ip := range []string{"10.0.1.5", "172.18.0.2", "127.0.0.1"} {
		a := wsAddr(t, ip)
		for i := 0; i < connMgrHigh; i++ {
			if !g.AllowReserve(testPeerID(t), a) {
				t.Fatalf("%s: reservation %d refused", ip, i)
			}
		}
	}
	if len(g.byPeer) != 0 {
		t.Fatalf("proxy-class reservations were tracked: %d", len(g.byPeer))
	}
}

// IPv6: each /64 is its own client, and the /48 has an aggregate share.
func TestReservationGateAggregatesIPv6(t *testing.T) {
	g := newReservationGate(time.Hour)
	granted := 0
	for sub := 0; sub < 16; sub++ {
		a := wsAddr(t, fmt.Sprintf("2001:db8:7:%x::1", sub))
		for i := 0; i < maxReservationsPerAddr; i++ {
			if g.AllowReserve(testPeerID(t), a) {
				granted++
			}
		}
	}
	if granted != maxReservationsPerAggregate {
		t.Fatalf("one /48 got %d reservations, want %d", granted, maxReservationsPerAggregate)
	}
}

// A reservation nobody refreshes lapses with the relay's own TTL.
func TestReservationGateExpires(t *testing.T) {
	g := newReservationGate(time.Hour)
	now := time.Now()
	g.now = func() time.Time { return now }
	host := wsAddr(t, "198.51.100.30")
	for i := 0; i < maxReservationsPerAddr; i++ {
		g.AllowReserve(testPeerID(t), host)
	}
	if g.AllowReserve(testPeerID(t), host) {
		t.Fatal("share not enforced")
	}
	now = now.Add(time.Hour + time.Second)
	if !g.AllowReserve(testPeerID(t), host) {
		t.Fatal("lapsed reservations still held the share")
	}
}

// A public address is one client's network and gets a realistic connection
// allowance; a proxy's address is everyone and is held only to the global
// ceiling (TestResourceManagerAllowsManyConnsFromOneIP covers that side).
func TestResourceManagerCapsOnePublicAddress(t *testing.T) {
	rm, err := newResourceManager()
	if err != nil {
		t.Fatalf("newResourceManager: %v", err)
	}
	defer rm.Close()
	remote := wsAddr(t, "198.51.100.40")
	var scopes []network.ConnManagementScope
	defer func() {
		for _, s := range scopes {
			s.Done()
		}
	}()
	for i := 0; i < maxConnsPerAddr; i++ {
		s, err := rm.OpenConnection(network.DirInbound, true, remote)
		if err != nil {
			t.Fatalf("connection %d from one public address refused inside its allowance: %v", i+1, err)
		}
		scopes = append(scopes, s)
	}
	if s, err := rm.OpenConnection(network.DirInbound, true, remote); err == nil {
		s.Done()
		t.Fatal("one public address got past its connection allowance")
	}
	s, err := rm.OpenConnection(network.DirInbound, true, wsAddr(t, "198.51.100.41"))
	if err != nil {
		t.Fatalf("another public address refused: %v", err)
	}
	scopes = append(scopes, s)
}

// A proxy on a PUBLIC address - a CDN in front of the relay - is named in
// TRUSTED_PROXY_CIDRS and then held only to the global ceiling too.
func TestResourceManagerTrustsANamedPublicProxy(t *testing.T) {
	withTrustedProxies(t, "203.0.113.0/24")
	rm, err := newResourceManager()
	if err != nil {
		t.Fatalf("newResourceManager: %v", err)
	}
	defer rm.Close()
	remote := wsAddr(t, "203.0.113.9")
	var scopes []network.ConnManagementScope
	defer func() {
		for _, s := range scopes {
			s.Done()
		}
	}()
	for i := 0; i < connMgrHigh; i++ {
		s, err := rm.OpenConnection(network.DirInbound, true, remote)
		if err != nil {
			t.Fatalf("connection %d through a named proxy refused: %v", i+1, err)
		}
		scopes = append(scopes, s)
	}
}

// The circuit limits are chosen, not inherited from memory-scaled service
// defaults, and none of them is tighter than what those defaults gave a
// small VPS.
func TestRelayCircuitLimitsArePinned(t *testing.T) {
	scaled := rcmgr.DefaultLimits.Scale(1<<30, 1024)
	limits := scaled.ToPartialLimitConfig()
	relayCircuitLimits(&limits)
	built := limits.Build(scaled).ToPartialLimitConfig()
	svc := built.Service[relayv2.ServiceName]
	if svc.StreamsInbound != rcmgr.LimitVal(2048) || svc.StreamsOutbound != rcmgr.LimitVal(2048) {
		t.Fatalf("relay service streams = %v/%v", svc.StreamsInbound, svc.StreamsOutbound)
	}
	hop := built.ProtocolPeer[circuitproto.ProtoIDv2Hop]
	if hop.StreamsInbound != rcmgr.LimitVal(128) {
		t.Fatalf("per-peer hop streams = %v", hop.StreamsInbound)
	}
	// Not tighter than the generic protocol defaults this replaced, at the
	// same scale: a tighter number fails calls, not attackers.
	def := scaled.ToPartialLimitConfig()
	if old := def.ProtocolDefault.StreamsInbound; int(old) > 2048 {
		t.Fatalf("pinned hop limit (2048) is below the old scaled default %v", old)
	}
	if old := def.ProtocolPeerDefault.StreamsInbound; int(old) > 128 {
		t.Fatalf("pinned per-peer hop limit (128) is below the old scaled default %v", old)
	}
}
