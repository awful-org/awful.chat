package main

import (
	"context"
	"sync/atomic"
	"testing"
	"time"

	"github.com/libp2p/go-libp2p/core/network"
	"github.com/libp2p/go-libp2p/core/peer"
	"github.com/libp2p/go-libp2p/core/protocol"
	rcmgr "github.com/libp2p/go-libp2p/p2p/host/resource-manager"
	"github.com/libp2p/go-libp2p/p2p/net/connmgr"
	circuitproto "github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/proto"
	relayv2 "github.com/libp2p/go-libp2p/p2p/protocol/circuitv2/relay"
)

// openRelayStream does to the resource manager what a stream the relay
// terminates does: it is opened, gets its protocol and service, and go-yamux
// reserves its window on the peer's scope.
func openRelayStream(t *testing.T, rm network.ResourceManager, p peer.ID, dir network.Direction, proto protocol.ID, service string) {
	t.Helper()
	s, err := rm.OpenStream(p, dir)
	if err != nil {
		t.Fatalf("%s stream refused: %v", proto, err)
	}
	if err := s.SetProtocol(proto); err != nil {
		t.Fatalf("%s stream refused its protocol: %v", proto, err)
	}
	if service != "" {
		if err := s.SetService(service); err != nil {
			t.Fatalf("%s stream refused its service: %v", proto, err)
		}
	}
	err = rm.ViewPeer(p, func(ps network.PeerScope) error {
		span, err := ps.BeginSpan()
		if err != nil {
			return err
		}
		return span.ReserveMemory(yamuxStreamWindow, network.ReservationPriorityAlways)
	})
	if err != nil {
		t.Fatalf("%s stream's window refused: %v", proto, err)
	}
}

// go-yamux charges a stream's whole 256 KiB window up front, and the
// System memory limit used to be an eighth of the host's RAM, so on a 2 GB
// VPS it - not any limit chosen for the relay - stopped circuits at about
// 580, short of one fully online 50-member room. The relay's own ceilings
// are what bind now: every connection it accepts can hold its rendezvous
// stream, and every circuit relayCircuitLimits allows can open, on a 1 GB
// and a 2 GB host alike.
func TestRelayAdmitsItsCircuitsOnASmallHost(t *testing.T) {
	for _, host := range []struct {
		name  string
		scale int64 // what AutoScale hands the resource manager: RAM/8
	}{{"1 GB", 128 << 20}, {"2 GB", 256 << 20}} {
		t.Run(host.name, func(t *testing.T) {
			rm, err := newResourceManagerFrom(rcmgr.DefaultLimits.Scale(host.scale, 32768))
			if err != nil {
				t.Fatal(err)
			}
			defer rm.Close()
			proxy := wsAddr(t, "10.0.0.5") // behind Traefik, everyone

			tabs := make([]peer.ID, relayMaxConns)
			for i := range tabs {
				tabs[i] = testPeerID(t)
				conn, err := rm.OpenConnection(network.DirInbound, true, proxy)
				if err != nil {
					t.Fatalf("connection %d of %d refused: %v", i+1, relayMaxConns, err)
				}
				if err := conn.SetPeer(tabs[i]); err != nil {
					t.Fatalf("connection %d refused its peer: %v", i+1, err)
				}
				openRelayStream(t, rm, tabs[i], network.DirInbound, RendezvousProtocol, "")
			}

			// The relay's circuit buffers come out of one span on its
			// service, at the priority circuitv2/relay/relay.go asks for.
			var service network.ResourceScopeSpan
			if err := rm.ViewService(relayv2.ServiceName, func(s network.ServiceScope) error {
				var err error
				service, err = s.BeginSpan()
				return err
			}); err != nil {
				t.Fatal(err)
			}
			buffers := 2 * relayv2.DefaultResources().BufferSize
			for i := 0; i < relayCircuits; i++ {
				src, dst := tabs[i%len(tabs)], tabs[(i+1)%len(tabs)]
				openRelayStream(t, rm, src, network.DirInbound, circuitproto.ProtoIDv2Hop, relayv2.ServiceName)
				openRelayStream(t, rm, dst, network.DirOutbound, circuitproto.ProtoIDv2Stop, relayv2.ServiceName)
				span, err := service.BeginSpan()
				if err != nil {
					t.Fatalf("circuit %d: %v", i+1, err)
				}
				if err := span.ReserveMemory(buffers, network.ReservationPriorityHigh); err != nil {
					t.Fatalf("circuit %d of %d refused its buffers with %d tabs online: %v", i+1, relayCircuits, relayMaxConns, err)
				}
			}
		})
	}
}

// fakeConn is enough of a connection for the connection manager: who is on
// the other end, its stats, and whether it was closed.
type fakeConn struct {
	network.Conn
	p      peer.ID
	closed atomic.Bool
}

func (c *fakeConn) RemotePeer() peer.ID { return c.p }
func (c *fakeConn) Stat() network.ConnStats {
	return network.ConnStats{Stats: network.Stats{Direction: network.DirInbound}, NumStreams: 1}
}
func (c *fakeConn) CloseWithError(network.ConnErrorCode) error { c.closed.Store(true); return nil }
func (c *fakeConn) Close() error                               { c.closed.Store(true); return nil }

// At 256/512, once 512 connections were open the connection manager closed
// all but 256 of those past their grace period every ~70 s - established
// tabs, each a PEER_LEFT to every room and a reconnect - and the same tabs
// every time. A tab holding a rendezvous stream is now protected: past the
// high water, nothing registered is trimmed.
func TestRegisteredTabsSurviveATrim(t *testing.T) {
	cm, err := newConnManager(connmgr.WithGracePeriod(time.Millisecond))
	if err != nil {
		t.Fatal(err)
	}
	defer cm.Close()
	r := newRegistry()
	r.protect = func(id string, on bool) {
		p, err := peer.Decode(id)
		if err != nil {
			t.Errorf("protect: %v", err)
			return
		}
		if on {
			cm.Protect(p, rendezvousProtectTag)
		} else {
			cm.Unprotect(p, rendezvousProtectTag)
		}
	}

	n := connMgrHigh + 600
	conns := make([]*fakeConn, n)
	streams := make([]*connectedClient, n)
	for i := range conns {
		conns[i] = &fakeConn{p: testPeerID(t)}
		cm.Notifee().Connected(nil, conns[i])
		streams[i], _ = newClient(r, conns[i].p.String())
	}
	closed := func() int {
		n := 0
		for _, c := range conns {
			if c.closed.Load() {
				n++
			}
		}
		return n
	}

	time.Sleep(10 * time.Millisecond) // every connection past its grace period
	cm.TrimOpenConns(context.Background())
	if c := closed(); c != 0 {
		t.Fatalf("a trim past the high water closed %d of %d registered tabs", c, n)
	}

	// A peer with two tabs stays protected until both have gone.
	p := conns[0].p
	second, _ := newClient(r, p.String())
	r.removeClient(streams[0])
	if !cm.IsProtected(p, rendezvousProtectTag) {
		t.Fatal("a peer still holding a rendezvous stream lost its protection")
	}
	r.removeClient(second)
	if cm.IsProtected(p, rendezvousProtectTag) {
		t.Fatal("a peer with no rendezvous stream left is still protected")
	}

	// Without their streams, the same connections are what a trim takes:
	// down to the low water.
	for _, c := range streams[1:] {
		r.removeClient(c)
	}
	cm.TrimOpenConns(context.Background())
	if c, want := closed(), n-connMgrLow; c != want {
		t.Fatalf("with no rendezvous streams a trim closed %d, want %d", c, want)
	}
}

func TestRelayMaxConnsParsing(t *testing.T) {
	for raw, want := range map[string]int{
		"":        defaultRelayMaxConns,
		" 4096 ":  4096,
		"10":      minRelayMaxConns,
		"9999999": maxRelayMaxConns,
		"lots":    defaultRelayMaxConns,
	} {
		if got := parseRelayMaxConns(raw); got != want {
			t.Errorf("RELAY_MAX_CONNS=%q: got %d, want %d", raw, got, want)
		}
	}
	if connMgrLow >= connMgrHigh || connMgrHigh != relayMaxConns {
		t.Errorf("watermarks %d/%d do not sit at and below the %d-connection ceiling", connMgrLow, connMgrHigh, relayMaxConns)
	}
}
